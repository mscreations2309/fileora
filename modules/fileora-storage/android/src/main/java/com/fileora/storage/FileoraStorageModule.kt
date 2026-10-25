package com.fileora.storage

import android.Manifest
import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import androidx.core.content.FileProvider
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

private const val BUFFER_SIZE = 256 * 1024
private const val PROGRESS_INTERVAL_MS = 200L
private const val PARTIAL_PREFIX = ".fileora-partial-"
private const val PROGRESS_EVENT = "onTransferProgress"
private const val HANDOFF_EVENT = "onHandoff"
private const val REMOTE_EVENT = "onRemote"

/**
 * Native storage helpers for Fileora on Android.
 *
 * Every location is addressed by a single URI string:
 *  - `file://` URIs are handled with java.io (shared storage with All-files access, app storage).
 *  - `content://` document URIs (built from a SAF tree grant) are handled with DocumentsContract,
 *    using a single ContentResolver query per directory listing instead of DocumentFile's
 *    per-property queries.
 *
 * All I/O runs on Dispatchers.IO so it never blocks the JS thread or the shared module queue.
 */
class FileoraStorageModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.AppContextLost()

  private val resolver: ContentResolver
    get() = context.contentResolver

  private val cancelledOperations: MutableSet<String> = ConcurrentHashMap.newKeySet()

  private val extraction by lazy { ContentExtraction(context) }

  private val hotspot by lazy { HotspotLink(context) }
  private val remote by lazy { RemoteServer(context) { body -> sendEvent(REMOTE_EVENT, body) } }
  private val handoff by lazy { Handoff(context, { hotspot.joinedNetwork }) { body -> sendEvent(HANDOFF_EVENT, body) } }

  override fun definition() = ModuleDefinition {
    Name("FileoraStorage")

    Events(PROGRESS_EVENT, HANDOFF_EVENT, REMOTE_EVENT)

    Function("getAllFilesAccessStatus") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        mapOf("mode" to "manage", "granted" to Environment.isExternalStorageManager())
      } else {
        val read = context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        val write = context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        mapOf("mode" to "legacy", "granted" to (read && write))
      }
    }

    Function("getAppStorageRoots") {
      mapOf(
        "internalFiles" to Uri.fromFile(context.filesDir).toString(),
        "externalFiles" to context.getExternalFilesDir(null)?.let { Uri.fromFile(it).toString() }
      )
    }

    AsyncFunction("getStorageVolumes") Coroutine { ->
      withContext(Dispatchers.IO) { storageVolumes() }
    }

    AsyncFunction("resolveTreeRoot") Coroutine { treeUri: String ->
      withContext(Dispatchers.IO) {
        guard("tree root") {
          val tree = Uri.parse(treeUri)
          val rootId = DocumentsContract.getTreeDocumentId(tree)
          val documentUri = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
          queryDocument(documentUri) ?: throw NotFoundException("granted folder is no longer available")
        }
      }
    }

    AsyncFunction("listChildren") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        guard("list folder") {
          val parsed = Uri.parse(uri)
          if (parsed.scheme == ContentResolver.SCHEME_CONTENT) listDocumentChildren(parsed) else listFileChildren(fileOf(parsed))
        }
      }
    }

    AsyncFunction("stat") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        try {
          guard("read metadata") { statUri(Uri.parse(uri)) }
        } catch (e: NotFoundException) {
          null
        }
      }
    }

    AsyncFunction("createDirectory") Coroutine { parentUri: String, name: String ->
      withContext(Dispatchers.IO) {
        guard("create folder") {
          validateName(name)
          val parent = Uri.parse(parentUri)
          if (parent.scheme == ContentResolver.SCHEME_CONTENT) {
            if (findChildDocument(parent, name) != null) throw AlreadyExistsException(name)
            val created = DocumentsContract.createDocument(resolver, parent, Document.MIME_TYPE_DIR, name)
              ?: throw IoFailureException("provider refused to create folder")
            queryDocument(created) ?: throw IoFailureException("created folder could not be read back")
          } else {
            val dir = File(fileOf(parent), name)
            if (dir.exists()) throw AlreadyExistsException(name)
            if (!dir.mkdir()) throw writeFailure(fileOf(parent), "could not create folder")
            fileEntry(dir)
          }
        }
      }
    }

    AsyncFunction("rename") Coroutine { uri: String, newName: String ->
      withContext(Dispatchers.IO) {
        guard("rename") {
          validateName(newName)
          val parsed = Uri.parse(uri)
          if (parsed.scheme == ContentResolver.SCHEME_CONTENT) {
            val renamed = DocumentsContract.renameDocument(resolver, parsed, newName) ?: parsed
            // Providers may adjust the name (e.g. to stay unique); report what actually happened.
            queryDocument(renamed) ?: throw IoFailureException("renamed item could not be read back")
          } else {
            fileEntry(renameFile(fileOf(parsed), newName))
          }
        }
      }
    }

    AsyncFunction("delete") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        guard("delete") {
          val parsed = Uri.parse(uri)
          if (parsed.scheme == ContentResolver.SCHEME_CONTENT) {
            if (!DocumentsContract.deleteDocument(resolver, parsed)) throw IoFailureException("provider refused to delete")
          } else {
            val file = fileOf(parsed)
            if (!file.exists()) throw NotFoundException(file.name)
            val deleted = if (file.isDirectory) file.deleteRecursively() else file.delete()
            if (!deleted) throw writeFailure(file.parentFile ?: file, "could not delete")
          }
          true
        }
      }
    }

    /**
     * Attempts a metadata-only move (same volume rename, or provider-side move).
     * Returns the new entry, or null when a fast move is impossible and the caller must
     * fall back to copy → verify → delete.
     */
    AsyncFunction("tryFastMove") Coroutine { sourceUri: String, sourceParentUri: String, destinationParentUri: String, name: String ->
      withContext(Dispatchers.IO) {
        guard("move") {
          validateName(name)
          val source = Uri.parse(sourceUri)
          val destinationParent = Uri.parse(destinationParentUri)
          when {
            source.scheme != ContentResolver.SCHEME_CONTENT && destinationParent.scheme != ContentResolver.SCHEME_CONTENT -> {
              val sourceFile = fileOf(source)
              val target = File(fileOf(destinationParent), name)
              if (target.exists()) throw AlreadyExistsException(name)
              if (sourceFile.renameTo(target)) fileEntry(target) else null
            }
            source.scheme == ContentResolver.SCHEME_CONTENT &&
              destinationParent.scheme == ContentResolver.SCHEME_CONTENT &&
              source.authority == destinationParent.authority -> {
              val current = queryDocument(source) ?: throw NotFoundException("source")
              if (current["canMove"] != true || current["name"] != name) return@guard null
              if (findChildDocument(destinationParent, name) != null) throw AlreadyExistsException(name)
              try {
                val moved = DocumentsContract.moveDocument(resolver, source, Uri.parse(sourceParentUri), destinationParent)
                moved?.let { queryDocument(it) }
              } catch (e: UnsupportedOperationException) {
                null
              }
            }
            else -> null
          }
        }
      }
    }

    /**
     * Streams a single file into a destination folder.
     * Data is written to a hidden partial file and only renamed into place after the whole
     * stream was written and flushed, so a failed or cancelled copy never leaves a truncated
     * file under the final name. Returns the SHA-256 of the bytes read from the source.
     */
    AsyncFunction("copyFile") Coroutine { operationId: String, sourceUri: String, destinationParentUri: String, name: String, mimeType: String?, overwrite: Boolean ->
      withContext(Dispatchers.IO) {
        try {
          guard("copy") { copyFile(operationId, Uri.parse(sourceUri), Uri.parse(destinationParentUri), name, mimeType, overwrite) }
        } finally {
          cancelledOperations.remove(operationId)
        }
      }
    }

    AsyncFunction("hash") Coroutine { uri: String, algorithm: String, operationId: String? ->
      withContext(Dispatchers.IO) {
        try {
          guard("hash") {
            val digest = MessageDigest.getInstance(digestName(algorithm))
            val parsed = Uri.parse(uri)
            val total = sizeOf(parsed)
            openInput(parsed).use { input ->
              streamTo(operationId, input, null, total, digest)
            }
            digest.digest().toHex()
          }
        } finally {
          if (operationId != null) cancelledOperations.remove(operationId)
        }
      }
    }

    AsyncFunction("readText") Coroutine { uri: String, maxBytes: Int ->
      withContext(Dispatchers.IO) { guard("read text") { extraction.readText(Uri.parse(uri), maxBytes) } }
    }

    AsyncFunction("readBytes") Coroutine { uri: String, offset: Long, length: Int ->
      withContext(Dispatchers.IO) {
        guard("read bytes") { android.util.Base64.encodeToString(extraction.readBytes(Uri.parse(uri), offset, length), android.util.Base64.NO_WRAP) }
      }
    }

    AsyncFunction("recognizeText") Coroutine { uri: String ->
      withContext(Dispatchers.IO) { guard("recognize text") { extraction.recognizeImage(Uri.parse(uri)) } }
    }

    AsyncFunction("extractPdfText") Coroutine { uri: String, maxPages: Int ->
      withContext(Dispatchers.IO) { guard("read PDF") { extraction.extractPdfText(Uri.parse(uri), maxPages) } }
    }

    AsyncFunction("extractOfficeDocument") Coroutine { uri: String ->
      withContext(Dispatchers.IO) { guard("read document") { extraction.extractOffice(Uri.parse(uri)) } }
    }

    AsyncFunction("imageHash") Coroutine { uri: String ->
      withContext(Dispatchers.IO) { guard("fingerprint image") { extraction.imageHash(Uri.parse(uri)) } }
    }

    AsyncFunction("writeFile") Coroutine { parentUri: String, name: String, base64: String, mimeType: String? ->
      withContext(Dispatchers.IO) {
        guard("write file") {
          val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
          writeNewFile(Uri.parse(parentUri), name, mimeType) { it.write(bytes) }
        }
      }
    }

    AsyncFunction("stripJpegMetadata") Coroutine { sourceUri: String, parentUri: String, name: String ->
      withContext(Dispatchers.IO) {
        guard("remove metadata") {
          var removed = 0
          val entry = extraction.open(Uri.parse(sourceUri)).use { input ->
            writeNewFile(Uri.parse(parentUri), name, "image/jpeg") { removed = extraction.stripJpegMetadata(input, it) }
          }
          entry + ("removedSegments" to removed)
        }
      }
    }

    /** PBKDF2-HMAC-SHA256 for wrapping the vault key with a passcode. Runs natively on a background thread. */
    AsyncFunction("deriveKey") Coroutine { password: String, saltBase64: String, iterations: Int, lengthBytes: Int ->
      withContext(Dispatchers.Default) {
        val salt = android.util.Base64.decode(saltBase64, android.util.Base64.NO_WRAP)
        val spec = javax.crypto.spec.PBEKeySpec(password.toCharArray(), salt, iterations, lengthBytes * 8)
        try {
          val factory = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
          android.util.Base64.encodeToString(factory.generateSecret(spec).encoded, android.util.Base64.NO_WRAP)
        } finally {
          spec.clearPassword()
        }
      }
    }

    AsyncFunction("handoffStartReceiving") Coroutine { sessionId: String, deviceName: String ->
      withContext(Dispatchers.IO) { guard("start receiving") { handoff.startReceiving(sessionId, deviceName) } }
    }

    Function("handoffRespond") { sessionId: String, accept: Boolean ->
      handoff.respondToPairing(sessionId, accept)
    }

    Function("handoffStopReceiving") { sessionId: String ->
      handoff.stopReceiving(sessionId)
    }

    Function("handoffSend") { sessionId: String, host: String, port: Int, transferId: String, deviceName: String, files: List<Map<String, Any?>> ->
      handoff.send(sessionId, host, port, transferId, deviceName, files)
    }

    Function("handoffCancel") { sessionId: String ->
      handoff.cancelSend(sessionId)
    }

    AsyncFunction("hotspotStart") Coroutine { ->
      withContext(Dispatchers.IO) { guard("start hotspot") { hotspot.start() } }
    }

    Function("hotspotStop") {
      hotspot.stop()
    }

    AsyncFunction("hotspotJoin") Coroutine { ssid: String, passphrase: String ->
      withContext(Dispatchers.IO) { guard("join hotspot") { hotspot.join(ssid, passphrase) } }
    }

    Function("hotspotLeave") {
      hotspot.leave()
    }

    AsyncFunction("remoteStart") Coroutine { port: Int, devices: List<Map<String, Any?>> ->
      withContext(Dispatchers.IO) {
        guard("start Fileora Web") {
          val info = remote.start(port, devices)
          @Suppress("UNCHECKED_CAST")
          val address = (info["addresses"] as List<String>).firstOrNull()?.let { "http://$it:${info["port"]}" }
          RemoteService.onStopRequested = {
            remote.stop()
            sendEvent(REMOTE_EVENT, mapOf("type" to "stopped"))
          }
          RemoteService.start(context, address)
          info
        }
      }
    }

    Function("remoteStop") {
      remote.stop()
      RemoteService.stop(context)
    }

    Function("remoteSetDevices") { devices: List<Map<String, Any?>> ->
      remote.setDevices(devices)
    }

    Function("remoteRespond") { requestId: String, json: String ->
      remote.respond(requestId, json)
    }

    Function("remoteResolvePairing") { pairId: String, accept: Boolean ->
      remote.resolvePairing(pairId, accept)
    }

    Function("remoteNotifyChange") { parentUri: String? ->
      remote.notifyChange(parentUri)
    }

    Function("handoffDiscard") { transferId: String ->
      handoff.discardStaged(transferId)
    }

    Function("cancel") { operationId: String ->
      cancelledOperations.add(operationId)
    }

    AsyncFunction("openFile") { uri: String, mimeType: String? ->
      val shareable = shareableUri(Uri.parse(uri))
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(shareable, mimeType ?: "*/*")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      if (context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).isEmpty()) {
        throw NoHandlerException(mimeType ?: "unknown type")
      }
      appContext.throwingActivity.startActivity(intent)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("shareFiles") { uris: List<String>, mimeType: String? ->
      if (uris.isEmpty()) throw UnsupportedException("nothing to share")
      val shareable = ArrayList(uris.map { shareableUri(Uri.parse(it)) })
      val intent = if (shareable.size == 1) {
        Intent(Intent.ACTION_SEND).apply { putExtra(Intent.EXTRA_STREAM, shareable[0]) }
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).apply { putParcelableArrayListExtra(Intent.EXTRA_STREAM, shareable) }
      }
      intent.type = mimeType ?: "*/*"
      // ClipData carries the read grant for every shared item through the chooser.
      intent.clipData = ClipData.newUri(resolver, "Fileora", shareable[0]).also { clip ->
        shareable.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
      }
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      appContext.throwingActivity.startActivity(Intent.createChooser(intent, null))
    }.runOnQueue(Queues.MAIN)

    Function("getPersistedPermissions") {
      resolver.persistedUriPermissions.map {
        mapOf(
          "uri" to it.uri.toString(),
          "read" to it.isReadPermission,
          "write" to it.isWritePermission,
          "persistedAt" to it.persistedTime
        )
      }
    }

    Function("releasePersistedPermission") { uri: String ->
      val parsed = Uri.parse(uri)
      val held = resolver.persistedUriPermissions.firstOrNull { it.uri == parsed } ?: return@Function false
      var flags = 0
      if (held.isReadPermission) flags = flags or Intent.FLAG_GRANT_READ_URI_PERMISSION
      if (held.isWritePermission) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      try {
        resolver.releasePersistableUriPermission(parsed, flags)
        true
      } catch (e: SecurityException) {
        false
      }
    }
  }

  // region Listing and metadata

  private fun listFileChildren(dir: File): List<Map<String, Any?>> {
    if (!dir.exists()) throw NotFoundException(dir.name)
    if (!dir.isDirectory) throw UnsupportedException("not a folder")
    val children = dir.listFiles() ?: throw AccessDeniedException(dir.name)
    return children.map { fileEntry(it) }
  }

  private fun fileEntry(file: File): Map<String, Any?> {
    val isDirectory = file.isDirectory
    val parentWritable = file.parentFile?.canWrite() == true
    return mapOf(
      "name" to file.name,
      "uri" to Uri.fromFile(file).toString(),
      "isDirectory" to isDirectory,
      "size" to if (isDirectory) null else file.length(),
      "modifiedAt" to file.lastModified().takeIf { it > 0 },
      "mimeType" to if (isDirectory) null else mimeFromName(file.name),
      "childCount" to if (isDirectory) file.list()?.size else null,
      "isHidden" to file.isHidden,
      "canWrite" to file.canWrite(),
      "canDelete" to parentWritable,
      "canRename" to parentWritable,
      "canMove" to parentWritable
    )
  }

  private val documentProjection = arrayOf(
    Document.COLUMN_DOCUMENT_ID,
    Document.COLUMN_DISPLAY_NAME,
    Document.COLUMN_MIME_TYPE,
    Document.COLUMN_SIZE,
    Document.COLUMN_LAST_MODIFIED,
    Document.COLUMN_FLAGS
  )

  private fun listDocumentChildren(parent: Uri): List<Map<String, Any?>> {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(parent, documentIdOf(parent))
    val cursor = resolver.query(childrenUri, documentProjection, null, null, null)
      ?: throw AccessDeniedException("folder could not be queried")
    return cursor.use { c ->
      val rows = ArrayList<Map<String, Any?>>(c.count)
      while (c.moveToNext()) rows.add(documentEntry(parent, c))
      rows
    }
  }

  private fun queryDocument(documentUri: Uri): Map<String, Any?>? {
    val cursor = resolver.query(documentUri, documentProjection, null, null, null) ?: return null
    return cursor.use { c -> if (c.moveToFirst()) documentEntry(documentUri, c) else null }
  }

  private fun findChildDocument(parent: Uri, name: String): Map<String, Any?>? =
    listDocumentChildren(parent).firstOrNull { it["name"] == name }

  private fun documentEntry(anyUriInTree: Uri, c: Cursor): Map<String, Any?> {
    val documentId = c.getString(0)
    val mime = c.getString(2)
    val isDirectory = mime == Document.MIME_TYPE_DIR
    val flags = if (c.isNull(5)) 0 else c.getInt(5)
    val name = c.getString(1) ?: documentId
    return mapOf(
      "name" to name,
      "uri" to DocumentsContract.buildDocumentUriUsingTree(anyUriInTree, documentId).toString(),
      "isDirectory" to isDirectory,
      "size" to if (isDirectory || c.isNull(3)) null else c.getLong(3),
      "modifiedAt" to if (c.isNull(4)) null else c.getLong(4).takeIf { it > 0 },
      "mimeType" to if (isDirectory) null else mime,
      "childCount" to null,
      "isHidden" to name.startsWith("."),
      "canWrite" to (flags and (Document.FLAG_SUPPORTS_WRITE or Document.FLAG_DIR_SUPPORTS_CREATE) != 0),
      "canDelete" to (flags and Document.FLAG_SUPPORTS_DELETE != 0),
      "canRename" to (flags and Document.FLAG_SUPPORTS_RENAME != 0),
      "canMove" to (flags and Document.FLAG_SUPPORTS_MOVE != 0)
    )
  }

  private fun statUri(uri: Uri): Map<String, Any?>? =
    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      queryDocument(uri)
    } else {
      val file = fileOf(uri)
      if (file.exists()) fileEntry(file) else null
    }

  private fun sizeOf(uri: Uri): Long {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return fileOf(uri).length()
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) return c.getLong(0)
    }
    return -1L
  }

  private fun storageVolumes(): List<Map<String, Any?>> {
    val manager = context.getSystemService(Context.STORAGE_SERVICE) as StorageManager
    val volumes = ArrayList<Map<String, Any?>>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      for (volume in manager.storageVolumes) {
        val dir = volume.directory ?: continue
        volumes.add(volumeEntry(volume.uuid ?: "primary", dir, volume.getDescription(context), volume.isPrimary, volume.isRemovable, volume.state))
      }
    } else {
      val primary = Environment.getExternalStorageDirectory()
      volumes.add(volumeEntry("primary", primary, null, true, Environment.isExternalStorageRemovable(), Environment.getExternalStorageState()))
      // App-specific dirs exist on every mounted volume; strip the app suffix to find the volume root.
      context.getExternalFilesDirs(null).drop(1).filterNotNull().forEach { appDir ->
        val root = File(appDir.absolutePath.substringBefore("/Android/data"))
        volumes.add(volumeEntry(root.name, root, null, false, true, Environment.getExternalStorageState(appDir)))
      }
    }
    return volumes
  }

  private fun volumeEntry(id: String, dir: File, label: String?, isPrimary: Boolean, isRemovable: Boolean, state: String): Map<String, Any?> {
    val stats = try {
      StatFs(dir.absolutePath)
    } catch (e: IllegalArgumentException) {
      null
    }
    return mapOf(
      "id" to id,
      "uri" to Uri.fromFile(dir).toString(),
      "label" to label,
      "isPrimary" to isPrimary,
      "isRemovable" to isRemovable,
      "isMounted" to (state == Environment.MEDIA_MOUNTED || state == Environment.MEDIA_MOUNTED_READ_ONLY),
      "isReadOnly" to (state == Environment.MEDIA_MOUNTED_READ_ONLY),
      "totalBytes" to stats?.totalBytes,
      "freeBytes" to stats?.availableBytes
    )
  }

  // endregion

  // region Mutations

  private fun renameFile(source: File, newName: String): File {
    if (!source.exists()) throw NotFoundException(source.name)
    val parent = source.parentFile ?: throw UnsupportedException("cannot rename a volume root")
    val target = File(parent, newName)
    val caseOnly = source.name != newName && source.name.equals(newName, ignoreCase = true)
    if (!caseOnly && target.exists()) throw AlreadyExistsException(newName)
    if (caseOnly) {
      // Shared storage is case-insensitive; go through a temporary name so the rename is observable.
      val temporary = File(parent, "$PARTIAL_PREFIX${System.nanoTime()}")
      if (!source.renameTo(temporary)) throw writeFailure(parent, "could not rename")
      if (!temporary.renameTo(target)) {
        temporary.renameTo(source)
        throw writeFailure(parent, "could not rename")
      }
    } else if (!source.renameTo(target)) {
      throw writeFailure(parent, "could not rename")
    }
    return target
  }

  private fun copyFile(operationId: String, source: Uri, destinationParent: Uri, name: String, mimeType: String?, overwrite: Boolean): Map<String, Any?> {
    validateName(name)
    if (cancelledOperations.contains(operationId)) throw CancelledException()
    val totalBytes = sizeOf(source)
    val digest = MessageDigest.getInstance("SHA-256")
    val partialName = "$PARTIAL_PREFIX$operationId-$name"

    if (destinationParent.scheme != ContentResolver.SCHEME_CONTENT) {
      val directory = fileOf(destinationParent)
      if (!directory.isDirectory) throw NotFoundException("destination folder")
      val target = File(directory, name)
      if (target.exists() && !overwrite) throw AlreadyExistsException(name)
      if (!directory.canWrite()) throw ReadOnlyException(directory.name)
      if (totalBytes > 0) {
        val available = StatFs(directory.absolutePath).availableBytes
        if (totalBytes > available) throw NoSpaceException(totalBytes, available)
      }
      val partial = File(directory, partialName)
      var committed = false
      try {
        openInput(source).use { input ->
          FileOutputStream(partial).use { output ->
            val copied = streamTo(operationId, input, output, totalBytes, digest)
            output.flush()
            output.fd.sync()
            if (totalBytes >= 0 && copied != totalBytes) throw IoFailureException("source changed during copy")
          }
        }
        if (target.exists()) {
          if (target.isDirectory || !target.delete()) throw writeFailure(directory, "could not replace existing file")
        }
        if (!partial.renameTo(target)) throw writeFailure(directory, "could not finalize copy")
        committed = true
        return fileEntry(target) + ("sha256" to digest.digest().toHex())
      } finally {
        if (!committed) partial.delete()
      }
    }

    val existing = findChildDocument(destinationParent, name)
    if (existing != null && (!overwrite || existing["isDirectory"] == true)) throw AlreadyExistsException(name)
    val partial = DocumentsContract.createDocument(resolver, destinationParent, mimeType ?: "application/octet-stream", partialName)
      ?: throw ReadOnlyException("provider refused to create file")
    var committed = false
    try {
      openInput(source).use { input ->
        val output = resolver.openOutputStream(partial, "w") ?: throw IoFailureException("destination could not be opened")
        output.use {
          val copied = streamTo(operationId, input, it, totalBytes, digest)
          it.flush()
          if (totalBytes >= 0 && copied != totalBytes) throw IoFailureException("source changed during copy")
        }
      }
      if (existing != null && !DocumentsContract.deleteDocument(resolver, Uri.parse(existing["uri"] as String))) {
        throw IoFailureException("could not replace existing file")
      }
      val finalUri = DocumentsContract.renameDocument(resolver, partial, name) ?: partial
      committed = true
      val entry = queryDocument(finalUri) ?: throw IoFailureException("copied file could not be read back")
      return entry + ("sha256" to digest.digest().toHex())
    } finally {
      if (!committed) {
        try {
          DocumentsContract.deleteDocument(resolver, partial)
        } catch (e: Exception) {
          // Best effort: the partial file is hidden and named after the operation, JS reports it.
        }
      }
    }
  }

  /** Writes a new file next to others with the same partial-then-rename guarantee as copies. */
  private fun writeNewFile(parent: Uri, name: String, mimeType: String?, write: (OutputStream) -> Unit): Map<String, Any?> {
    validateName(name)
    val partialName = "$PARTIAL_PREFIX${System.nanoTime()}-$name"
    if (parent.scheme != ContentResolver.SCHEME_CONTENT) {
      val directory = fileOf(parent)
      val target = File(directory, name)
      if (target.exists()) throw AlreadyExistsException(name)
      val partial = File(directory, partialName)
      var committed = false
      try {
        FileOutputStream(partial).use { output ->
          write(output)
          output.flush()
          output.fd.sync()
        }
        if (!partial.renameTo(target)) throw writeFailure(directory, "could not finalize file")
        committed = true
        return fileEntry(target)
      } finally {
        if (!committed) partial.delete()
      }
    }
    if (findChildDocument(parent, name) != null) throw AlreadyExistsException(name)
    val partial = DocumentsContract.createDocument(resolver, parent, mimeType ?: "application/octet-stream", partialName)
      ?: throw ReadOnlyException("provider refused to create file")
    var committed = false
    try {
      (resolver.openOutputStream(partial, "w") ?: throw IoFailureException("destination could not be opened")).use { write(it) }
      val finalUri = DocumentsContract.renameDocument(resolver, partial, name) ?: partial
      committed = true
      return queryDocument(finalUri) ?: throw IoFailureException("written file could not be read back")
    } finally {
      if (!committed) {
        try {
          DocumentsContract.deleteDocument(resolver, partial)
        } catch (e: Exception) {
          // Best effort; the partial name is hidden from listings.
        }
      }
    }
  }

  private fun streamTo(operationId: String?, input: InputStream, output: OutputStream?, totalBytes: Long, digest: MessageDigest?): Long {
    val buffer = ByteArray(BUFFER_SIZE)
    var processed = 0L
    var lastEmit = 0L
    while (true) {
      if (operationId != null && cancelledOperations.contains(operationId)) throw CancelledException()
      val read = input.read(buffer)
      if (read < 0) break
      output?.write(buffer, 0, read)
      digest?.update(buffer, 0, read)
      processed += read
      if (operationId != null) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now
          emitProgress(operationId, processed, totalBytes)
        }
      }
    }
    if (operationId != null) emitProgress(operationId, processed, totalBytes)
    return processed
  }

  private fun emitProgress(operationId: String, processed: Long, total: Long) {
    sendEvent(
      PROGRESS_EVENT,
      mapOf("operationId" to operationId, "bytesProcessed" to processed, "totalBytes" to if (total >= 0) total else null)
    )
  }

  // endregion

  // region Helpers

  private fun openInput(uri: Uri): InputStream =
    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      resolver.openInputStream(uri) ?: throw IoFailureException("source could not be opened")
    } else {
      FileInputStream(fileOf(uri))
    }

  /** Content URIs are passed through; file URIs are wrapped by Fileora's FileProvider. */
  private fun shareableUri(uri: Uri): Uri =
    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      uri
    } else {
      FileProvider.getUriForFile(context, "${context.packageName}.fileora.files", fileOf(uri))
    }

  private fun fileOf(uri: Uri): File {
    if (uri.scheme != ContentResolver.SCHEME_FILE) throw UnsupportedException("scheme ${uri.scheme}")
    val path = uri.path ?: throw NotFoundException("empty path")
    return File(path)
  }

  private fun documentIdOf(uri: Uri): String =
    if (DocumentsContract.isDocumentUri(context, uri)) DocumentsContract.getDocumentId(uri) else DocumentsContract.getTreeDocumentId(uri)

  private fun validateName(name: String) {
    if (name.isBlank() || name == "." || name == ".." || name.contains('/') || name.contains('\u0000')) {
      throw InvalidNameException(name)
    }
    if (name.toByteArray(Charsets.UTF_8).size > 255) throw InvalidNameException("name is too long")
  }

  private fun mimeFromName(name: String): String? {
    val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
    if (extension.isEmpty()) return null
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
  }

  private fun digestName(algorithm: String): String = when (algorithm.uppercase(Locale.ROOT)) {
    "SHA-256", "SHA256" -> "SHA-256"
    "SHA-1", "SHA1" -> "SHA-1"
    "MD5" -> "MD5"
    else -> throw UnsupportedException("hash algorithm $algorithm")
  }

  private fun writeFailure(directory: File, detail: String): CodedException =
    if (!directory.canWrite()) ReadOnlyException(directory.name) else IoFailureException(detail)

  private inline fun <T> guard(detail: String, block: () -> T): T {
    try {
      return block()
    } catch (e: CodedException) {
      throw e
    } catch (e: SecurityException) {
      throw AccessDeniedException(detail, e)
    } catch (e: FileNotFoundException) {
      val message = e.message.orEmpty()
      if (message.contains("EACCES") || message.contains("Permission denied")) throw AccessDeniedException(detail, e)
      if (message.contains("EROFS")) throw ReadOnlyException(detail)
      throw NotFoundException(detail)
    } catch (e: IOException) {
      val message = e.message.orEmpty()
      if (message.contains("ENOSPC") || message.contains("No space left")) throw NoSpaceException(-1, -1)
      if (message.contains("EROFS")) throw ReadOnlyException(detail)
      throw IoFailureException(detail, e)
    } catch (e: UnsupportedOperationException) {
      throw UnsupportedException(detail)
    } catch (e: IllegalArgumentException) {
      // DocumentsContract throws this for documents that no longer exist in the tree.
      throw NotFoundException(detail)
    } catch (e: IllegalStateException) {
      throw IoFailureException(detail, e)
    }
  }

  private fun ByteArray.toHex(): String {
    val chars = CharArray(size * 2)
    val digits = "0123456789abcdef"
    forEachIndexed { i, byte ->
      val v = byte.toInt() and 0xff
      chars[i * 2] = digits[v ushr 4]
      chars[i * 2 + 1] = digits[v and 0x0f]
    }
    return String(chars)
  }

  // endregion
}
