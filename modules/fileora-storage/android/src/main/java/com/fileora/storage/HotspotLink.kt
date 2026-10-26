package com.fileora.storage

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * SHAREit-style direct link: the receiver starts Android's local-only hotspot (random name and password,
 * no internet, only while receiving) and the sender joins it through the system's "connect to device"
 * prompt. Nothing leaves the two devices, and no shared Wi-Fi or router is needed.
 *
 * The hotspot only provides the link. Pairing still uses the 6-digit code and AES-GCM from [Handoff].
 */
internal class HotspotLink(private val context: Context) {
  private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
  private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val main = Handler(Looper.getMainLooper())

  @Volatile private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
  @Volatile private var joinCallback: ConnectivityManager.NetworkCallback? = null

  /** The network joined with [join], used to route the sender's socket. Null when using the normal network. */
  @Volatile var joinedNetwork: Network? = null
    private set

  // region Receiver: host a hotspot

  fun start(): Map<String, Any?> {
    stop()
    val latch = CountDownLatch(1)
    var failure: String? = null
    var started: WifiManager.LocalOnlyHotspotReservation? = null
    val callback = object : WifiManager.LocalOnlyHotspotCallback() {
      override fun onStarted(value: WifiManager.LocalOnlyHotspotReservation) {
        started = value
        latch.countDown()
      }

      override fun onFailed(reason: Int) {
        failure = when (reason) {
          ERROR_INCOMPATIBLE_MODE -> "Turn off your phone's mobile hotspot, then try again"
          ERROR_TETHERING_DISALLOWED -> "This phone does not allow apps to create a hotspot"
          ERROR_NO_CHANNEL -> "No free Wi-Fi channel for a hotspot right now"
          else -> "The phone could not start a hotspot"
        }
        latch.countDown()
      }
    }
    try {
      main.post {
        try {
          wifi.startLocalOnlyHotspot(callback, main)
        } catch (e: SecurityException) {
          failure = "Allow Nearby devices (or Location) so Fileora can create a hotspot"
          latch.countDown()
        } catch (e: IllegalStateException) {
          failure = "A hotspot is already running for another app"
          latch.countDown()
        }
      }
      if (!latch.await(15, TimeUnit.SECONDS)) throw IoFailureException("the hotspot did not start in time")
    } catch (e: InterruptedException) {
      throw IoFailureException("interrupted while starting the hotspot", e)
    }
    failure?.let { throw IoFailureException(it) }
    val active = started ?: throw IoFailureException("the hotspot did not start")
    reservation = active

    val (ssid, passphrase) = credentials(active)
    if (ssid.isNullOrEmpty() || passphrase.isNullOrEmpty()) {
      stop()
      throw IoFailureException("the hotspot did not report its name and password")
    }
    return mapOf("ssid" to ssid, "passphrase" to passphrase, "addresses" to hotspotAddresses())
  }

  fun stop() {
    runCatching { reservation?.close() }
    reservation = null
  }

  @Suppress("DEPRECATION")
  private fun credentials(active: WifiManager.LocalOnlyHotspotReservation): Pair<String?, String?> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val config = active.softApConfiguration
      val ssid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) config.wifiSsid?.toString()?.trim('"') else config.ssid
      return ssid to config.passphrase
    }
    val config = active.wifiConfiguration ?: return null to null
    return config.SSID?.trim('"') to config.preSharedKey?.trim('"')
  }

  /** The hotspot's own address appears on a separate interface (ap0, swlan0, wlan1…) a moment after it starts. */
  private fun hotspotAddresses(): List<String> {
    repeat(20) {
      val found = interfaceAddresses { name -> name.startsWith("ap") || name.startsWith("swlan") || name.startsWith("softap") || name == "wlan1" || name == "wlan2" }
      if (found.isNotEmpty()) return found
      Thread.sleep(150)
    }
    return emptyList()
  }

  private fun interfaceAddresses(matches: (String) -> Boolean): List<String> =
    NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
      .filter { runCatching { it.isUp && !it.isLoopback && matches(it.name) }.getOrDefault(false) }
      .flatMap { iface -> iface.inetAddresses.toList().filterIsInstance<Inet4Address>().filter { !it.isLoopbackAddress && !it.isLinkLocalAddress }.mapNotNull { it.hostAddress } }

  // endregion

  // region Sender: join a hotspot

  /** Joins the receiver's hotspot. Android shows its own confirmation; resolves once the link is up. */
  fun join(ssid: String, passphrase: String): Map<String, Any?> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw UnsupportedException("joining automatically needs Android 10 or newer — join Wi-Fi \"$ssid\" in Settings instead")
    }
    leave()
    val specifier = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(passphrase).build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    val latch = CountDownLatch(1)
    var available: Network? = null
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        available = network
        joinedNetwork = network
        latch.countDown()
      }

      override fun onUnavailable() {
        latch.countDown()
      }

      override fun onLost(network: Network) {
        if (joinedNetwork == network) joinedNetwork = null
      }
    }
    joinCallback = callback
    connectivity.requestNetwork(request, callback, 60_000)
    try {
      latch.await(65, TimeUnit.SECONDS)
    } catch (e: InterruptedException) {
      throw IoFailureException("interrupted while joining", e)
    }
    if (available == null) {
      leave()
      throw IoFailureException("could not join the other device's hotspot (declined, out of range or timed out)")
    }
    return mapOf("joined" to true)
  }

  fun leave() {
    joinCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
    joinCallback = null
    joinedNetwork = null
  }

  // endregion
}
