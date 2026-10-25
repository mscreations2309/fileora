package com.fileora.storage

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

/**
 * Smart Handoff: direct, encrypted, verified transfer between two Fileora devices on the same network.
 *
 * Security: ephemeral ECDH (P-256) per session → HKDF-SHA256 session keys; both devices show a 6-digit
 * code derived from the shared secret, and the receiver must explicitly accept after comparing it, which
 * defeats man-in-the-middle attacks. All messages after the hello are AES-256-GCM with per-direction
 * sequence numbers in the associated data. Nothing listens unless the user starts receiving.
 *
 * Integrity: every file is hashed (SHA-256) by the sender; the receiver stages data in app storage and
 * only reports a file as received after its hash matches. Partial files are kept so a retry resumes.
 */
internal class Handoff(
  private val context: Context,
  /** When set (sender joined the receiver's hotspot), sockets are routed over that network. */
  private val route: () -> android.net.Network? = { null },
  private val emit: (Map<String, Any?>) -> Unit
) {
  private val random = SecureRandom()
  private val receivers = ConcurrentHashMap<String, Receiver>()
  private val senders = ConcurrentHashMap<String, Sender>()

  // region Public API

  fun startReceiving(sessionId: String, deviceName: String): Map<String, Any?> {
    val server = ServerSocket()
    server.reuseAddress = true
    server.bind(InetSocketAddress(0))
    val receiver = Receiver(sessionId, server, deviceName)
    receivers[sessionId] = receiver
    thread(name = "fileora-handoff-accept", isDaemon = true) { receiver.acceptLoop() }
    return mapOf("port" to server.localPort, "addresses" to localAddresses(), "emulator" to isEmulator())
  }

  fun respondToPairing(sessionId: String, accept: Boolean) {
    receivers[sessionId]?.respond(accept)
  }

  fun stopReceiving(sessionId: String) {
    receivers.remove(sessionId)?.close()
  }

  fun send(sessionId: String, host: String, port: Int, transferId: String, deviceName: String, files: List<Map<String, Any?>>) {
    val sender = Sender(sessionId, host, port, transferId, deviceName, files)
    senders[sessionId] = sender
    thread(name = "fileora-handoff-send", isDaemon = true) {
      try {
        sender.run()
      } finally {
        senders.remove(sessionId)
      }
    }
  }

  fun cancelSend(sessionId: String) {
    senders[sessionId]?.close()
  }

  /** Removes staged partial data for a transfer (after success or when the user gives up). */
  fun discardStaged(transferId: String) {
    stagingDir(transferId).deleteRecursively()
  }

  // endregion

  // region Protocol

  private object Type {
    const val HELLO: Int = 1
    const val MANIFEST: Int = 2
    const val ACCEPT: Int = 3
    const val REJECT: Int = 4
    const val DATA: Int = 5
    const val FILE_END: Int = 6
    const val FILE_RESULT: Int = 7
    const val DONE: Int = 8
  }

  private class Channel(private val socket: Socket) {
    val input = DataInputStream(socket.getInputStream().buffered(256 * 1024))
    val output = DataOutputStream(socket.getOutputStream().buffered(256 * 1024))
    var sendKey: SecretKeySpec? = null
    var receiveKey: SecretKeySpec? = null
    private var sendSeq = 0L
    private var receiveSeq = 0L
    private val random = SecureRandom()

    fun writePlain(type: Int, payload: ByteArray) {
      output.writeByte(type)
      output.writeInt(payload.size)
      output.write(payload)
      output.flush()
    }

    fun readPlain(): Pair<Int, ByteArray> {
      val type = input.readUnsignedByte()
      val length = input.readInt()
      if (length < 0 || length > MAX_FRAME) throw IllegalStateException("frame too large")
      val payload = ByteArray(length)
      input.readFully(payload)
      return type to payload
    }

    fun write(type: Int, payload: ByteArray, flush: Boolean = true) {
      val key = sendKey ?: throw IllegalStateException("not paired")
      val iv = ByteArray(12).also { random.nextBytes(it) }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
      cipher.updateAAD(aad(type, sendSeq++))
      val sealed = cipher.doFinal(payload)
      output.writeByte(type)
      output.writeInt(iv.size + sealed.size)
      output.write(iv)
      output.write(sealed)
      if (flush) output.flush()
    }

    fun read(): Pair<Int, ByteArray> {
      val (type, frame) = readPlain()
      val key = receiveKey ?: throw IllegalStateException("not paired")
      if (frame.size < 12 + 16) throw IllegalStateException("frame too short")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, frame, 0, 12))
      cipher.updateAAD(aad(type, receiveSeq++))
      return type to cipher.doFinal(frame, 12, frame.size - 12)
    }

    private fun aad(type: Int, seq: Long): ByteArray = ByteBuffer.allocate(9).put(type.toByte()).putLong(seq).array()
  }

  private class Session(val sas: String, val senderToReceiver: SecretKeySpec, val receiverToSender: SecretKeySpec)

  /** Ephemeral ECDH, then HKDF-SHA256 into two directional keys and a short authentication string. */
  private fun handshake(channel: Channel, isSender: Boolean, deviceName: String): Pair<Session, String> {
    val generator = KeyPairGenerator.getInstance("EC")
    generator.initialize(ECGenParameterSpec("secp256r1"))
    val keyPair = generator.generateKeyPair()
    val nonce = ByteArray(16).also { random.nextBytes(it) }
    val hello = JSONObject().put("v", 1).put("name", deviceName.take(64))
      .put("key", android.util.Base64.encodeToString(keyPair.public.encoded, android.util.Base64.NO_WRAP))
      .put("nonce", android.util.Base64.encodeToString(nonce, android.util.Base64.NO_WRAP))
    channel.writePlain(Type.HELLO, hello.toString().toByteArray())
    val (type, payload) = channel.readPlain()
    if (type != Type.HELLO) throw IllegalStateException("unexpected message")
    val peer = JSONObject(String(payload))
    if (peer.optInt("v") != 1) throw IllegalStateException("incompatible Fileora version")
    val peerKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(android.util.Base64.decode(peer.getString("key"), android.util.Base64.NO_WRAP)))
    val peerNonce = android.util.Base64.decode(peer.getString("nonce"), android.util.Base64.NO_WRAP)
    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(keyPair.private)
    agreement.doPhase(peerKey, true)
    val secret = agreement.generateSecret()
    val salt = if (isSender) nonce + peerNonce else peerNonce + nonce
    val prk = hmac(salt, secret)
    val s2r = SecretKeySpec(expand(prk, "fileora-handoff s2r", 32), "AES")
    val r2s = SecretKeySpec(expand(prk, "fileora-handoff r2s", 32), "AES")
    val sasBytes = expand(prk, "fileora-handoff sas", 4)
    val sasNumber = (ByteBuffer.wrap(sasBytes).int.toLong() and 0xffffffffL) % 1_000_000
    secret.fill(0)
    val session = Session(sasNumber.toString().padStart(6, '0'), s2r, r2s)
    channel.sendKey = if (isSender) s2r else r2s
    channel.receiveKey = if (isSender) r2s else s2r
    return session to peer.optString("name", "Unknown device").take(64)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  private fun expand(prk: ByteArray, info: String, length: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(prk, "HmacSHA256"))
    mac.update(info.toByteArray())
    mac.update(1)
    return mac.doFinal().copyOf(length)
  }

  // endregion

  // region Receiver

  private fun stagingDir(transferId: String): File {
    val safe = transferId.filter { it.isLetterOrDigit() || it == '-' }.take(64)
    return File(context.cacheDir, "handoff/$safe").apply { mkdirs() }
  }

  private inner class Receiver(private val sessionId: String, private val server: ServerSocket, private val deviceName: String) {
    @Volatile private var closed = false
    @Volatile private var decision: Boolean? = null
    private var latch = CountDownLatch(1)
    @Volatile private var active: Socket? = null

    fun acceptLoop() {
      emit(mapOf("session" to sessionId, "event" to "listening"))
      while (!closed) {
        val socket = try {
          server.accept()
        } catch (e: Exception) {
          break
        }
        if (active != null) {
          // One transfer at a time; refuse others.
          runCatching { socket.close() }
          continue
        }
        active = socket
        try {
          handle(socket)
        } catch (e: Exception) {
          if (!closed) emit(mapOf("session" to sessionId, "event" to "error", "message" to (e.message ?: "Connection failed")))
        } finally {
          runCatching { socket.close() }
          active = null
          if (!closed) emit(mapOf("session" to sessionId, "event" to "listening"))
        }
      }
    }

    fun respond(accept: Boolean) {
      decision = accept
      latch.countDown()
    }

    fun close() {
      closed = true
      latch.countDown()
      runCatching { active?.close() }
      runCatching { server.close() }
    }

    private fun handle(socket: Socket) {
      socket.soTimeout = 120_000
      val channel = Channel(socket)
      val (session, peerName) = handshake(channel, isSender = false, deviceName = deviceName)
      val (type, payload) = channel.read()
      if (type != Type.MANIFEST) throw IllegalStateException("unexpected message")
      val manifest = JSONObject(String(payload))
      val transferId = manifest.getString("transferId")
      val files = manifest.getJSONArray("files")
      if (files.length() > 10_000) throw IllegalStateException("too many files")
      val paths = ArrayList<String>()
      var total = 0L
      for (i in 0 until files.length()) {
        val file = files.getJSONObject(i)
        val path = file.getString("path")
        if (!safePath(path)) throw IllegalStateException("unsafe file path in transfer")
        val size = file.getLong("size")
        if (size < 0) throw IllegalStateException("invalid size")
        paths.add(path)
        total += size
      }
      decision = null
      latch = CountDownLatch(1)
      emit(mapOf("session" to sessionId, "event" to "pairing", "code" to session.sas, "peer" to peerName, "transferId" to transferId, "fileCount" to files.length(), "totalBytes" to total, "files" to paths.take(50)))
      // Wait for the user to compare the code and accept; give up after 2 minutes.
      latch.await(120, TimeUnit.SECONDS)
      if (decision != true) {
        channel.write(Type.REJECT, ByteArray(0))
        emit(mapOf("session" to sessionId, "event" to "rejected"))
        return
      }
      val staging = stagingDir(transferId)
      val resume = JSONObject()
      for (i in 0 until files.length()) {
        val part = File(staging, "$i.part")
        resume.put(i.toString(), if (part.exists()) part.length() else 0L)
      }
      channel.write(Type.ACCEPT, JSONObject().put("resume", resume).toString().toByteArray())
      emit(mapOf("session" to sessionId, "event" to "receiving", "transferId" to transferId))

      var current = -1
      var out: FileOutputStream? = null
      var received = 0L
      var lastEmit = 0L
      try {
        while (true) {
          val (frameType, body) = channel.read()
          when (frameType) {
            Type.DATA -> {
              val buffer = ByteBuffer.wrap(body)
              val index = buffer.int
              if (index < 0 || index >= files.length()) throw IllegalStateException("bad file index")
              if (index != current) {
                out?.close()
                current = index
                out = FileOutputStream(File(staging, "$index.part"), true)
              }
              out!!.write(body, 4, body.size - 4)
              received += body.size - 4
              val now = System.currentTimeMillis()
              if (now - lastEmit > 250) {
                lastEmit = now
                emit(mapOf("session" to sessionId, "event" to "progress", "file" to index, "bytes" to received))
              }
            }
            Type.FILE_END -> {
              out?.close()
              out = null
              val index = ByteBuffer.wrap(body).int
              if (index < 0 || index >= files.length()) throw IllegalStateException("bad file index")
              val spec = files.getJSONObject(index)
              val part = File(staging, "$index.part")
              val actual = if (part.exists()) sha256(part.inputStream()) else ""
              val ok = part.exists() && part.length() == spec.getLong("size") && actual == spec.getString("sha256")
              if (!ok) part.delete()
              channel.write(Type.FILE_RESULT, JSONObject().put("index", index).put("ok", ok).toString().toByteArray())
              emit(mapOf("session" to sessionId, "event" to if (ok) "fileVerified" else "fileFailed", "file" to index, "path" to spec.getString("path"), "stagedUri" to Uri.fromFile(part).toString(), "size" to spec.getLong("size"), "sha256" to spec.getString("sha256")))
            }
            Type.DONE -> {
              emit(mapOf("session" to sessionId, "event" to "completed", "transferId" to transferId))
              return
            }
            else -> throw IllegalStateException("unexpected message")
          }
        }
      } finally {
        out?.close()
      }
    }
  }

  /** Relative path with no traversal, absolute parts, drive letters or control characters. */
  private fun safePath(path: String): Boolean {
    if (path.isEmpty() || path.length > 1024 || path.startsWith("/") || path.contains('\\') || path.contains('\u0000')) return false
    return path.split('/').all { it.isNotEmpty() && it != "." && it != ".." && !it.contains(':') && it.toByteArray().size <= 255 }
  }

  // endregion

  // region Sender

  private inner class Sender(
    private val sessionId: String,
    private val host: String,
    private val port: Int,
    private val transferId: String,
    private val deviceName: String,
    private val files: List<Map<String, Any?>>
  ) {
    @Volatile private var socket: Socket? = null
    @Volatile private var closed = false

    fun close() {
      closed = true
      runCatching { socket?.close() }
    }

    /** `host` may list several addresses (from a pairing QR code); the first that answers wins. */
    private fun connectAny(): Socket {
      val hosts = host.split(',').map { it.trim() }.filter { it.isNotEmpty() }
      var lastError: Exception? = null
      for (candidate in hosts) {
        if (closed) throw IllegalStateException("cancelled")
        val s = Socket()
        socket = s
        try {
          route()?.bindSocket(s)
          s.connect(InetSocketAddress(candidate, port), if (hosts.size > 1) 4_000 else 10_000)
          return s
        } catch (e: Exception) {
          runCatching { s.close() }
          lastError = e
        }
      }
      throw lastError ?: IllegalArgumentException("No address to connect to")
    }

    fun run() {
      try {
        // Hash every file first so the receiver can verify what arrives.
        val manifest = JSONArray()
        files.forEachIndexed { index, file ->
          if (closed) throw IllegalStateException("cancelled")
          emit(mapOf("session" to sessionId, "event" to "preparing", "file" to index))
          val uri = Uri.parse(file["uri"] as String)
          manifest.put(JSONObject().put("path", file["path"] as String).put("size", (file["size"] as Number).toLong()).put("sha256", sha256(open(uri))))
        }
        val s = connectAny()
        s.soTimeout = 150_000
        val channel = Channel(s)
        val (session, peerName) = handshake(channel, isSender = true, deviceName = deviceName)
        emit(mapOf("session" to sessionId, "event" to "pairing", "code" to session.sas, "peer" to peerName))
        channel.write(Type.MANIFEST, JSONObject().put("transferId", transferId).put("files", manifest).toString().toByteArray())
        val (reply, body) = channel.read()
        if (reply == Type.REJECT) {
          emit(mapOf("session" to sessionId, "event" to "rejected"))
          return
        }
        if (reply != Type.ACCEPT) throw IllegalStateException("unexpected reply")
        val resume = JSONObject(String(body)).getJSONObject("resume")
        emit(mapOf("session" to sessionId, "event" to "accepted"))
        val buffer = ByteArray(CHUNK)
        var sent = 0L
        var lastEmit = 0L
        files.forEachIndexed { index, file ->
          val offset = resume.optLong(index.toString(), 0L)
          open(Uri.parse(file["uri"] as String)).use { input ->
            var skipped = 0L
            while (skipped < offset) {
              val step = input.skip(offset - skipped)
              if (step <= 0) break
              skipped += step
            }
            sent += skipped
            while (true) {
              if (closed) throw IllegalStateException("cancelled")
              val read = input.read(buffer)
              if (read < 0) break
              val frame = ByteBuffer.allocate(4 + read).putInt(index).put(buffer, 0, read).array()
              channel.write(Type.DATA, frame, flush = false)
              sent += read
              val now = System.currentTimeMillis()
              if (now - lastEmit > 250) {
                lastEmit = now
                emit(mapOf("session" to sessionId, "event" to "progress", "file" to index, "bytes" to sent))
              }
            }
          }
          channel.write(Type.FILE_END, ByteBuffer.allocate(4).putInt(index).array())
          val (resultType, resultBody) = channel.read()
          if (resultType != Type.FILE_RESULT) throw IllegalStateException("unexpected reply")
          val result = JSONObject(String(resultBody))
          emit(mapOf("session" to sessionId, "event" to if (result.getBoolean("ok")) "fileVerified" else "fileFailed", "file" to index))
        }
        channel.write(Type.DONE, ByteArray(0))
        emit(mapOf("session" to sessionId, "event" to "completed", "bytes" to sent))
      } catch (e: Exception) {
        emit(mapOf("session" to sessionId, "event" to if (closed) "cancelled" else "error", "message" to (e.message ?: "Connection failed")))
      } finally {
        runCatching { socket?.close() }
      }
    }
  }

  // endregion

  private fun open(uri: Uri): InputStream =
    if (uri.scheme == "content") context.contentResolver.openInputStream(uri) ?: throw IllegalStateException("file could not be opened")
    else File(uri.path ?: "").inputStream()

  private fun sha256(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    input.use {
      val buffer = ByteArray(256 * 1024)
      while (true) {
        val read = it.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun localAddresses(): List<String> {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val network = manager.activeNetwork ?: return emptyList()
    val properties: LinkProperties = manager.getLinkProperties(network) ?: return emptyList()
    return properties.linkAddresses.mapNotNull { (it.address as? Inet4Address)?.hostAddress }
  }

  /** Emulators sit behind the host computer's NAT, so other devices cannot connect to them. */
  private fun isEmulator(): Boolean =
    Build.FINGERPRINT.startsWith("generic") || Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") || Build.PRODUCT.contains("sdk")

  companion object {
    private const val CHUNK = 512 * 1024
    private const val MAX_FRAME = CHUNK + 4 + 12 + 16 + 64
  }
}
