package com.fileora.storage

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Fileora Web: a small HTTP server so a laptop on the same Wi-Fi (or on this phone's hotspot) can browse
 * and manage files in a browser. Nothing goes to the internet.
 *
 * Trust model:
 * - Off unless the user turns it on. Every laptop must be approved on the phone (6-digit code shown on
 *   both screens); approval issues a random 256-bit token. Only its SHA-256 is kept.
 * - A laptop can only touch URIs the app has listed to it (roots and folder listings), so app-private
 *   data, the Vault and Trash are unreachable even with a valid token.
 * - Mutations (rename, new folder, delete-to-Trash, saving uploads) are performed by the JS app through
 *   its normal journaled engine, so they appear in History and can be undone like any other change.
 * - Requests must target an IP/localhost Host (blocks DNS rebinding) and, for writes, come from the
 *   page itself (Origin check).
 * Plain HTTP: traffic is protected by the Wi-Fi/hotspot encryption, not by TLS. Documented in the UI.
 */
internal class RemoteServer(private val context: Context, private val emit: (Map<String, Any?>) -> Unit) {
  private class Device(val id: String, val name: String, val tokenHash: String)
  private class Pairing(val id: String, val name: String, val code: String, val createdAt: Long) {
    @Volatile var status = "pending"
    @Volatile var token: String? = null
    @Volatile var deviceId: String? = null
  }
  private class EventClient(val deviceId: String, val socket: Socket, val out: OutputStream)

  private val random = SecureRandom()
  private val devices = ConcurrentHashMap<String, Device>() // tokenHash -> device
  private val pairings = ConcurrentHashMap<String, Pairing>()
  private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
  private val allowed: MutableSet<String> = ConcurrentHashMap.newKeySet()
  private val directories: MutableSet<String> = ConcurrentHashMap.newKeySet()
  private val events = CopyOnWriteArrayList<EventClient>()
  private val workers = Executors.newFixedThreadPool(24)
  private val uploads = File(context.cacheDir, "remote-uploads")

  @Volatile private var server: ServerSocket? = null
  @Volatile private var heartbeat: Thread? = null

  val running: Boolean get() = server != null

  // region Lifecycle

  fun start(preferredPort: Int, known: List<Map<String, Any?>>): Map<String, Any?> {
    setDevices(known)
    server?.let { return mapOf("port" to it.localPort, "addresses" to addresses()) }
    uploads.mkdirs()
    uploads.listFiles()?.forEach { it.delete() }
    val socket = ServerSocket()
    socket.reuseAddress = true
    try {
      socket.bind(InetSocketAddress(preferredPort))
    } catch (e: Exception) {
      socket.bind(InetSocketAddress(0)) // preferred port busy: any free port
    }
    server = socket
    thread(name = "fileora-web-accept", isDaemon = true) { acceptLoop(socket) }
    heartbeat = thread(name = "fileora-web-heartbeat", isDaemon = true) {
      while (server === socket) {
        try {
          Thread.sleep(20_000)
        } catch (e: InterruptedException) {
          break
        }
        broadcast(": ping\n\n", null)
        val now = System.currentTimeMillis()
        pairings.values.removeIf { now - it.createdAt > 5 * 60_000 }
      }
    }
    return mapOf("port" to socket.localPort, "addresses" to addresses())
  }

  fun stop() {
    val socket = server ?: return
    server = null
    runCatching { socket.close() }
    heartbeat?.interrupt()
    events.forEach { runCatching { it.socket.close() } }
    events.clear()
    pending.values.forEach { it.complete(JSONObject().put("ok", false).put("error", "Remote access was turned off")) }
    pending.clear()
    allowed.clear()
    directories.clear()
  }

  fun setDevices(known: List<Map<String, Any?>>) {
    val next = known.mapNotNull {
      val id = it["id"] as? String ?: return@mapNotNull null
      val hash = it["tokenHash"] as? String ?: return@mapNotNull null
      Device(id, it["name"] as? String ?: "Laptop", hash)
    }.associateBy { it.tokenHash }
    devices.keys.retainAll(next.keys)
    devices.putAll(next)
    // Revoked laptops lose their live connection immediately.
    val ids = next.values.map { it.id }.toSet()
    events.filter { it.deviceId !in ids }.forEach { client ->
      runCatching { client.socket.close() }
      events.remove(client)
    }
  }

  fun addresses(): List<String> =
    NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
      .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
      .flatMap { iface -> iface.inetAddresses.toList().filterIsInstance<Inet4Address>().filter { it.isSiteLocalAddress }.mapNotNull { it.hostAddress } }
      .distinct()

  // endregion

  // region Calls from JS

  fun respond(requestId: String, json: String) {
    val reply = runCatching { JSONObject(json) }.getOrElse { JSONObject().put("ok", false).put("error", "Bad response") }
    pending.remove(requestId)?.complete(reply)
  }

  fun resolvePairing(pairId: String, accept: Boolean): Map<String, Any?>? {
    val pairing = pairings[pairId] ?: return null
    if (pairing.status != "pending") return null
    if (!accept) {
      pairing.status = "declined"
      return null
    }
    val token = ByteArray(32).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    val device = Device(UUID.randomUUID().toString(), pairing.name, sha256(token))
    devices[device.tokenHash] = device
    pairing.token = token
    pairing.deviceId = device.id
    pairing.status = "approved"
    return mapOf("id" to device.id, "name" to device.name, "tokenHash" to device.tokenHash)
  }

  /** Tells connected browsers that something changed (`parentUri` null = refresh everything). */
  fun notifyChange(parentUri: String?) {
    val data = JSONObject().put("parentUri", parentUri ?: JSONObject.NULL).toString()
    broadcast("event: changed\ndata: $data\n\n", null)
  }

  // endregion

  // region HTTP

  private class Request(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>, val input: InputStream)

  private fun acceptLoop(socket: ServerSocket) {
    while (server === socket) {
      val client = try {
        socket.accept()
      } catch (e: Exception) {
        break
      }
      try {
        workers.execute { handle(client) }
      } catch (e: Exception) {
        runCatching { client.close() }
      }
    }
  }

  private fun handle(client: Socket) {
    var keepOpen = false
    try {
      client.soTimeout = 60_000
      val input = BufferedInputStream(client.getInputStream())
      val out = client.getOutputStream()
      val request = readRequest(input) ?: return
      if (!hostAllowed(request.headers["host"])) return send(out, 421, "text/plain", "Misdirected request".toByteArray())
      keepOpen = route(request, client, out)
    } catch (e: SocketException) {
      // Browser went away mid-request.
    } catch (e: Exception) {
      runCatching { send(client.getOutputStream(), 500, "application/json", error(e.message ?: "Server error")) }
    } finally {
      if (!keepOpen) runCatching { client.close() }
    }
  }

  private fun readRequest(input: InputStream): Request? {
    val line = readLine(input) ?: return null
    val parts = line.split(" ")
    if (parts.size < 2) return null
    val headers = HashMap<String, String>()
    while (true) {
      val header = readLine(input) ?: return null
      if (header.isEmpty()) break
      val colon = header.indexOf(':')
      if (colon > 0) headers[header.substring(0, colon).trim().lowercase()] = header.substring(colon + 1).trim()
      if (headers.size > 100) return null
    }
    val target = parts[1]
    val q = target.indexOf('?')
    val path = if (q >= 0) target.substring(0, q) else target
    val query = if (q >= 0) parseQuery(target.substring(q + 1)) else emptyMap()
    return Request(parts[0].uppercase(), path, query, headers, input)
  }

  private fun readLine(input: InputStream): String? {
    val buffer = StringBuilder()
    while (true) {
      val b = input.read()
      if (b < 0) return if (buffer.isEmpty()) null else buffer.toString()
      if (b == '\n'.code) return buffer.toString().trimEnd('\r')
      buffer.append(b.toChar())
      if (buffer.length > 16_384) return null
    }
  }

  private fun parseQuery(raw: String): Map<String, String> =
    raw.split('&').filter { it.isNotEmpty() }.associate {
      val eq = it.indexOf('=')
      val key = if (eq >= 0) it.substring(0, eq) else it
      val value = if (eq >= 0) it.substring(eq + 1) else ""
      URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
    }

  /** Only IP literals or localhost: a hostile site cannot rebind its own domain name to this phone. */
  private fun hostAllowed(host: String?): Boolean {
    if (host == null) return false
    val name = host.substringBeforeLast(':').trim('[', ']')
    return name == "localhost" || Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(name)
  }

  private fun sameOrigin(request: Request): Boolean {
    val origin = request.headers["origin"] ?: return true // same-origin GETs and old browsers omit it
    val host = request.headers["host"] ?: return false
    return origin == "http://$host"
  }

  private fun route(request: Request, client: Socket, out: OutputStream): Boolean {
    val path = request.path
    when {
      request.method == "GET" && (path == "/" || path == "/index.html") -> serveAsset(out, "fileora-web/index.html", "text/html; charset=utf-8")
      request.method == "GET" && path == "/favicon.ico" -> send(out, 204, "text/plain", ByteArray(0))
      request.method == "POST" && path == "/api/pair" -> startPairing(request, out)
      request.method == "GET" && path.startsWith("/api/pair/") -> pairingStatus(path.removePrefix("/api/pair/"), out)
      path.startsWith("/api/") -> {
        val device = authenticate(request) ?: run {
          send(out, 401, "application/json", error("This laptop is not paired (or was removed on the phone)"))
          return false
        }
        if (request.method != "GET" && !sameOrigin(request)) {
          send(out, 403, "application/json", error("Cross-site request blocked"))
          return false
        }
        return api(request, device, client, out)
      }
      else -> send(out, 404, "text/plain", "Not found".toByteArray())
    }
    return false
  }

  private fun authenticate(request: Request): Device? {
    val bearer = request.headers["authorization"]?.removePrefix("Bearer ")?.trim()
    val token = bearer?.takeIf { it.isNotEmpty() } ?: request.query["t"] ?: return null
    if (token.length != 64) return null
    return devices[sha256(token)]
  }

  private fun api(request: Request, device: Device, client: Socket, out: OutputStream): Boolean {
    when (request.path) {
      "/api/events" -> {
        out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nX-Content-Type-Options: nosniff\r\n\r\n".toByteArray())
        out.write("event: hello\ndata: {\"name\":${JSONObject.quote(device.name)}}\n\n".toByteArray())
        out.flush()
        client.soTimeout = 0
        events.add(EventClient(device.id, client, out))
        emit(mapOf("type" to "seen", "deviceId" to device.id))
        return true
      }
      "/api/roots" -> {
        val reply = ask(device, "roots", JSONObject())
        reply.optJSONArray("roots")?.let { roots ->
          for (i in 0 until roots.length()) roots.optJSONObject(i)?.optString("uri")?.let { allowed.add(it); directories.add(it) }
        }
        sendJson(out, reply)
      }
      "/api/list" -> {
        val uri = request.query["uri"] ?: return badRequest(out)
        if (uri !in directories) return forbidden(out)
        val reply = ask(device, "list", JSONObject().put("uri", uri))
        reply.optJSONArray("entries")?.let { entries ->
          for (i in 0 until entries.length()) entries.optJSONObject(i)?.let { entry ->
            val child = entry.optString("uri")
            allowed.add(child)
            if (entry.optBoolean("isDirectory")) directories.add(child)
          }
        }
        sendJson(out, reply)
      }
      "/api/download" -> {
        val uri = request.query["uri"] ?: return badRequest(out)
        if (uri !in allowed || uri in directories) return forbidden(out)
        download(uri, request.query["inline"] == "1", out)
        emit(mapOf("type" to "activity", "deviceId" to device.id, "action" to "download", "uri" to uri))
      }
      "/api/upload" -> {
        if (request.method != "POST") return badRequest(out)
        val parent = request.query["parent"] ?: return badRequest(out)
        val name = request.query["name"]?.trim().orEmpty()
        if (parent !in directories) return forbidden(out)
        if (name.isEmpty() || name.length > 255 || name.contains('/') || name == "." || name == "..") return badRequest(out)
        val length = request.headers["content-length"]?.toLongOrNull() ?: run {
          send(out, 411, "application/json", error("Upload size missing"))
          return false
        }
        val staged = File(uploads, UUID.randomUUID().toString())
        try {
          staged.outputStream().use { target -> copyExactly(request.input, target, length) }
          sendJson(out, ask(device, "import", JSONObject().put("staged", Uri.fromFile(staged).toString()).put("parent", parent).put("name", name), 10 * 60))
        } finally {
          staged.delete()
        }
      }
      "/api/rename", "/api/mkdir", "/api/delete" -> {
        if (request.method != "POST") return badRequest(out)
        val body = readBody(request) ?: return badRequest(out)
        val op = request.path.removePrefix("/api/")
        val ok = when (op) {
          "rename" -> body.optString("uri") in allowed && body.optString("uri") !in roots()
          "mkdir" -> body.optString("parent") in directories
          else -> body.optJSONArray("uris")?.let { list -> (0 until list.length()).all { list.optString(it) in allowed && list.optString(it) !in roots() } } ?: false
        }
        if (!ok) return forbidden(out)
        sendJson(out, ask(device, op, body))
      }
      else -> send(out, 404, "application/json", error("Unknown endpoint"))
    }
    return false
  }

  private val rootUris: MutableSet<String> = ConcurrentHashMap.newKeySet()
  private fun roots(): Set<String> = rootUris

  /** Forwards a request to the JS app and waits for its answer. */
  private fun ask(device: Device, op: String, args: JSONObject, timeoutSeconds: Long = 60): JSONObject {
    val id = UUID.randomUUID().toString()
    val future = CompletableFuture<JSONObject>()
    pending[id] = future
    emit(mapOf("type" to "request", "id" to id, "op" to op, "deviceId" to device.id, "deviceName" to device.name, "args" to args.toString()))
    val reply = try {
      future.get(timeoutSeconds, TimeUnit.SECONDS)
    } catch (e: Exception) {
      JSONObject().put("ok", false).put("error", "The phone did not answer in time")
    } finally {
      pending.remove(id)
    }
    if (op == "roots") reply.optJSONArray("roots")?.let { list -> for (i in 0 until list.length()) list.optJSONObject(i)?.optString("uri")?.let(rootUris::add) }
    return reply
  }

  private fun readBody(request: Request): JSONObject? {
    val length = request.headers["content-length"]?.toIntOrNull() ?: return null
    if (length > 1_000_000) return null
    val bytes = ByteArray(length)
    var read = 0
    while (read < length) {
      val n = request.input.read(bytes, read, length - read)
      if (n < 0) return null
      read += n
    }
    return runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrNull()
  }

  private fun copyExactly(input: InputStream, output: OutputStream, length: Long) {
    val buffer = ByteArray(256 * 1024)
    var remaining = length
    while (remaining > 0) {
      val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
      if (n < 0) throw java.io.IOException("upload interrupted")
      output.write(buffer, 0, n)
      remaining -= n
    }
  }

  private fun download(uriString: String, inline: Boolean, out: OutputStream) {
    val uri = Uri.parse(uriString)
    val (name, size) = describe(uri)
    val stream: InputStream = when (uri.scheme) {
      "content" -> context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("cannot open")
      else -> FileInputStream(File(uri.path ?: throw java.io.IOException("bad path")))
    }
    stream.use { source ->
      val disposition = (if (inline) "inline" else "attachment") + "; filename*=UTF-8''" + URLEncoder.encode(name, "UTF-8").replace("+", "%20")
      val header = StringBuilder("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: $disposition\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n")
      if (size != null && size >= 0) header.append("Content-Length: $size\r\n")
      header.append("\r\n")
      out.write(header.toString().toByteArray())
      source.copyTo(out, 256 * 1024)
      out.flush()
    }
  }

  private fun describe(uri: Uri): Pair<String, Long?> {
    if (uri.scheme == "content") {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) return (c.getString(0) ?: "file") to (if (c.isNull(1)) null else c.getLong(1))
      }
      return (uri.lastPathSegment?.substringAfterLast('/') ?: "file") to null
    }
    val file = File(uri.path ?: "")
    return file.name to file.length()
  }

  private fun startPairing(request: Request, out: OutputStream) {
    if (!sameOrigin(request)) return send(out, 403, "application/json", error("Cross-site request blocked"))
    if (pairings.values.count { it.status == "pending" } >= 3) return send(out, 429, "application/json", error("Too many pairing requests — approve or wait a minute"))
    val body = readBody(request) ?: JSONObject()
    val name = body.optString("name").trim().take(60).ifEmpty { "Laptop" }
    val pairing = Pairing(UUID.randomUUID().toString(), name, "%06d".format(random.nextInt(1_000_000)), System.currentTimeMillis())
    pairings[pairing.id] = pairing
    emit(mapOf("type" to "pair", "pairId" to pairing.id, "name" to name, "code" to pairing.code))
    sendJson(out, JSONObject().put("ok", true).put("pairId", pairing.id).put("code", pairing.code))
  }

  private fun pairingStatus(pairId: String, out: OutputStream) {
    val pairing = pairings[pairId] ?: return send(out, 404, "application/json", error("Pairing expired — start again"))
    val reply = JSONObject().put("ok", true).put("status", pairing.status)
    if (pairing.status == "approved") {
      reply.put("token", pairing.token).put("deviceId", pairing.deviceId)
      pairings.remove(pairId) // the token is handed out exactly once
    } else if (pairing.status == "declined") {
      pairings.remove(pairId)
    }
    sendJson(out, reply)
  }

  private fun broadcast(message: String, deviceId: String?) {
    val bytes = message.toByteArray()
    for (client in events) {
      if (deviceId != null && client.deviceId != deviceId) continue
      try {
        synchronized(client.out) {
          client.out.write(bytes)
          client.out.flush()
        }
      } catch (e: Exception) {
        runCatching { client.socket.close() }
        events.remove(client)
      }
    }
  }

  private fun serveAsset(out: OutputStream, path: String, type: String) {
    val bytes = context.assets.open(path).use { it.readBytes() }
    send(out, 200, type, bytes, extra = "Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n")
  }

  private fun sendJson(out: OutputStream, json: JSONObject) {
    val ok = json.optBoolean("ok", true)
    send(out, if (ok) 200 else 422, "application/json; charset=utf-8", json.toString().toByteArray())
  }

  private fun error(message: String): ByteArray = JSONObject().put("ok", false).put("error", message).toString().toByteArray()

  private fun badRequest(out: OutputStream): Boolean {
    send(out, 400, "application/json", error("Bad request"))
    return false
  }

  private fun forbidden(out: OutputStream): Boolean {
    send(out, 403, "application/json", error("That item is not available from the laptop — refresh the folder"))
    return false
  }

  private fun send(out: OutputStream, status: Int, type: String, body: ByteArray, extra: String = "") {
    val reason = when (status) {
      200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
      411 -> "Length Required"; 421 -> "Misdirected Request"; 422 -> "Unprocessable Entity"; 429 -> "Too Many Requests"; else -> "Error"
    }
    out.write("HTTP/1.1 $status $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n$extra\r\n".toByteArray())
    out.write(body)
    out.flush()
  }

  // endregion

  private fun sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
}
