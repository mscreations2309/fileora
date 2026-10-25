package com.fileora.storage

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps Fileora Web reachable while the phone is locked: a visible foreground service ("Fileora Web is
 * on" notification with a Turn off action) plus Wi-Fi and partial wake locks, held only while remote
 * access is on.
 */
class RemoteService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      onStopRequested?.invoke()
      stopSelf()
      return START_NOT_STICKY
    }
    val address = intent?.getStringExtra(EXTRA_ADDRESS)
    val notification = buildNotification(address)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    acquireLocks()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  private fun buildNotification(address: String?): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Fileora Web", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while laptops on your network can access your files"
      })
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val stop = PendingIntent.getService(this, 1, Intent(this, RemoteService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setContentTitle("Fileora Web is on")
      .setContentText(address?.let { "Open $it on a laptop on the same network" } ?: "Laptops you approved can access your files")
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null, "Turn off", stop).build())
      .build()
  }

  @Suppress("DEPRECATION")
  private fun acquireLocks() {
    if (wakeLock == null) {
      wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fileora:web").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    if (wifiLock == null) {
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createWifiLock(mode, "fileora:web").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
  }

  private fun releaseLocks() {
    runCatching { wakeLock?.release() }
    runCatching { wifiLock?.release() }
    wakeLock = null
    wifiLock = null
  }

  companion object {
    private const val CHANNEL_ID = "fileora-web"
    private const val NOTIFICATION_ID = 7310
    private const val ACTION_STOP = "com.fileora.storage.web.STOP"
    private const val EXTRA_ADDRESS = "address"

    /** Set by the module so the notification's Turn off action can stop the server. */
    @Volatile internal var onStopRequested: (() -> Unit)? = null

    internal fun start(context: Context, address: String?) {
      val intent = Intent(context, RemoteService::class.java).putExtra(EXTRA_ADDRESS, address)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }

    internal fun stop(context: Context) {
      context.stopService(Intent(context, RemoteService::class.java))
    }
  }
}
