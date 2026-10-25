package com.fileora.storage

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Xml
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.ZipInputStream
import kotlin.math.max
import kotlin.math.min
import java.util.concurrent.ExecutionException

/**
 * On-device content extraction. Nothing here touches the network: OCR uses ML Kit's bundled model.
 * All parsers treat input as untrusted: sizes are capped, archives are streamed and never written to
 * disk, and malformed input raises a coded error instead of crashing.
 */
internal class ContentExtraction(private val context: Context) {
  private val resolver: ContentResolver get() = context.contentResolver
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  fun readText(uri: Uri, maxBytes: Int): Map<String, Any?> {
    open(uri).use { input ->
      val bytes = readUpTo(input, maxBytes + 1)
      val truncated = bytes.size > maxBytes
      val slice = if (truncated) bytes.copyOf(maxBytes) else bytes
      return mapOf("text" to String(slice, Charsets.UTF_8), "truncated" to truncated)
    }
  }

  fun readBytes(uri: Uri, offset: Long, length: Int): ByteArray {
    open(uri).use { input ->
      var skipped = 0L
      while (skipped < offset) {
        val step = input.skip(offset - skipped)
        if (step <= 0) break
        skipped += step
      }
      return readUpTo(input, length)
    }
  }

  fun recognizeImage(uri: Uri): Map<String, Any?> {
    val bitmap = decodeSampled(uri, OCR_MAX_DIMENSION) ?: throw UnsupportedException("image could not be decoded")
    try {
      return recognize(bitmap)
    } finally {
      bitmap.recycle()
    }
  }

  fun extractPdfText(uri: Uri, maxPages: Int): Map<String, Any?> {
    val descriptor = openDescriptor(uri)
    descriptor.use { pfd ->
      val renderer = try {
        PdfRenderer(pfd)
      } catch (e: SecurityException) {
        throw UnsupportedException("password-protected PDF")
      } catch (e: java.io.IOException) {
        throw UnsupportedException("PDF could not be opened")
      }
      renderer.use {
        val pages = ArrayList<String>()
        val count = renderer.pageCount
        for (index in 0 until min(count, maxPages)) {
          renderer.openPage(index).use { page ->
            val scale = min(2f, OCR_MAX_DIMENSION.toFloat() / max(page.width, page.height))
            val width = max(1, (page.width * scale).toInt())
            val height = max(1, (page.height * scale).toInt())
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
              bitmap.eraseColor(Color.WHITE)
              page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              pages.add(recognize(bitmap)["text"] as String)
            } finally {
              bitmap.recycle()
            }
          }
        }
        return mapOf("pageCount" to count, "pages" to pages)
      }
    }
  }

  /** docx / xlsx / pptx: text plus privacy-relevant structure (metadata, hidden sheets, tracked changes). */
  fun extractOffice(uri: Uri): Map<String, Any?> {
    val text = StringBuilder()
    val metadata = HashMap<String, String>()
    val hiddenSheets = ArrayList<String>()
    var insertions = 0
    var deletions = 0
    var comments = 0
    var totalBytes = 0L
    var kind = "unknown"
    open(uri).use { raw ->
      ZipInputStream(raw).use { zip ->
        while (true) {
          val entry = zip.nextEntry ?: break
          val name = entry.name
          val interesting = name == "word/document.xml" || name == "word/comments.xml" || name == "docProps/core.xml" ||
            name == "docProps/app.xml" || name == "xl/sharedStrings.xml" || name == "xl/workbook.xml" ||
            (name.startsWith("ppt/slides/slide") && name.endsWith(".xml")) ||
            (name.startsWith("xl/worksheets/sheet") && name.endsWith(".xml"))
          if (!interesting) continue
          val bytes = readUpTo(zip, MAX_ENTRY_BYTES + 1)
          if (bytes.size > MAX_ENTRY_BYTES) throw UnsupportedException("document part is too large")
          totalBytes += bytes.size
          if (totalBytes > MAX_ARCHIVE_BYTES) throw UnsupportedException("document is too large to inspect")
          when {
            name == "word/document.xml" -> {
              kind = "docx"
              val counts = parseWordDocument(bytes, text)
              insertions += counts.first
              deletions += counts.second
            }
            name == "word/comments.xml" -> comments += countTags(bytes, "comment")
            name == "docProps/core.xml" || name == "docProps/app.xml" -> parseProperties(bytes, metadata)
            name == "xl/sharedStrings.xml" -> {
              kind = "xlsx"
              collectText(bytes, setOf("t"), text)
            }
            name == "xl/workbook.xml" -> {
              kind = "xlsx"
              parseWorkbook(bytes, hiddenSheets)
            }
            name.startsWith("xl/worksheets/") -> collectText(bytes, setOf("t"), text)
            name.startsWith("ppt/slides/") -> {
              kind = "pptx"
              collectText(bytes, setOf("t"), text)
            }
          }
        }
      }
    }
    return mapOf(
      "kind" to kind,
      "text" to text.toString().take(MAX_TEXT_CHARS),
      "metadata" to metadata,
      "hiddenSheets" to hiddenSheets,
      "trackedInsertions" to insertions,
      "trackedDeletions" to deletions,
      "comments" to comments
    )
  }

  /** 64-bit difference hash of a small grayscale thumbnail; similar images have a small Hamming distance. */
  fun imageHash(uri: Uri): String {
    val bitmap = decodeSampled(uri, 64) ?: throw UnsupportedException("image could not be decoded")
    try {
      val small = Bitmap.createScaledBitmap(bitmap, 9, 8, true)
      try {
        var hash = 0L
        var bit = 0
        for (y in 0 until 8) {
          for (x in 0 until 8) {
            if (luminance(small.getPixel(x, y)) > luminance(small.getPixel(x + 1, y))) hash = hash or (1L shl bit)
            bit += 1
          }
        }
        return java.lang.Long.toHexString(hash).padStart(16, '0')
      } finally {
        if (small !== bitmap) small.recycle()
      }
    } finally {
      bitmap.recycle()
    }
  }

  /**
   * Copies a JPEG without metadata segments (EXIF/XMP APP1, IPTC APP13, comments). Image data is copied
   * byte-for-byte, so quality is unchanged. Returns the number of segments removed.
   */
  fun stripJpegMetadata(input: InputStream, output: OutputStream): Int {
    val data = java.io.DataInputStream(java.io.BufferedInputStream(input))
    if (data.readUnsignedByte() != 0xFF || data.readUnsignedByte() != 0xD8) throw UnsupportedException("not a JPEG file")
    output.write(byteArrayOf(0xFF.toByte(), 0xD8.toByte()))
    var removed = 0
    while (true) {
      var marker = data.readUnsignedByte()
      if (marker != 0xFF) throw UnsupportedException("malformed JPEG")
      while (marker == 0xFF) marker = data.readUnsignedByte()
      if (marker == 0xDA) {
        // Start of scan: everything after this is entropy-coded image data; copy the rest verbatim.
        output.write(byteArrayOf(0xFF.toByte(), 0xDA.toByte()))
        data.copyTo(output)
        return removed
      }
      if (marker == 0xD9) {
        output.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte()))
        return removed
      }
      val length = data.readUnsignedShort()
      if (length < 2) throw UnsupportedException("malformed JPEG segment")
      val payload = ByteArray(length - 2)
      data.readFully(payload)
      // Remove EXIF/XMP (APP1), IPTC (APP13), comments and vendor blocks. Keep APP0 (JFIF), APP2 (ICC colour
      // profile) and APP14 (Adobe colour transform) so the image looks exactly the same.
      val isMetadata = marker == 0xE1 || marker == 0xED || marker == 0xFE || marker in 0xE3..0xEC || marker == 0xEF
      if (isMetadata) {
        removed += 1
      } else {
        output.write(byteArrayOf(0xFF.toByte(), marker.toByte(), (length shr 8).toByte(), (length and 0xFF).toByte()))
        output.write(payload)
      }
    }
  }

  // region helpers

  fun open(uri: Uri): InputStream =
    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      resolver.openInputStream(uri) ?: throw IoFailureException("file could not be opened")
    } else {
      File(uri.path ?: throw NotFoundException("empty path")).inputStream()
    }

  private fun openDescriptor(uri: Uri): ParcelFileDescriptor =
    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      resolver.openFileDescriptor(uri, "r") ?: throw IoFailureException("file could not be opened")
    } else {
      ParcelFileDescriptor.open(File(uri.path ?: throw NotFoundException("empty path")), ParcelFileDescriptor.MODE_READ_ONLY)
    }

  private fun decodeSampled(uri: Uri, maxDimension: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDimension) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return open(uri).use { BitmapFactory.decodeStream(it, null, options) }
  }

  private fun recognize(bitmap: Bitmap): Map<String, Any?> {
    val result = try {
      Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)))
    } catch (e: ExecutionException) {
      val cause = e.cause
      // The model comes from Google Play services; until it has downloaded, report a retryable failure.
      if (cause is MlKitException && cause.errorCode == MlKitException.UNAVAILABLE) {
        throw IoFailureException("text recognition is still being set up by Google Play services", cause)
      }
      throw e
    }
    val lines = ArrayList<String>()
    for (block in result.textBlocks) for (line in block.lines) lines.add(line.text)
    return mapOf("text" to result.text, "lines" to lines)
  }

  private fun luminance(color: Int): Int = (Color.red(color) * 299 + Color.green(color) * 587 + Color.blue(color) * 114) / 1000

  private fun parser(bytes: ByteArray): XmlPullParser =
    Xml.newPullParser().apply {
      setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
      setInput(ByteArrayInputStream(bytes), "UTF-8")
    }

  private fun localName(name: String): String = name.substringAfter(':')

  private fun collectText(bytes: ByteArray, tags: Set<String>, into: StringBuilder) {
    val p = parser(bytes)
    var inside = false
    while (p.next() != XmlPullParser.END_DOCUMENT) {
      when (p.eventType) {
        XmlPullParser.START_TAG -> inside = localName(p.name) in tags
        XmlPullParser.TEXT -> if (inside && into.length < MAX_TEXT_CHARS) into.append(p.text)
        XmlPullParser.END_TAG -> if (inside && localName(p.name) in tags) {
          inside = false
          into.append(' ')
        }
      }
    }
    into.append('\n')
  }

  /** Word body text, paragraph-separated, plus counts of tracked insertions/deletions. */
  private fun parseWordDocument(bytes: ByteArray, into: StringBuilder): Pair<Int, Int> {
    val p = parser(bytes)
    var inText = false
    var insertions = 0
    var deletions = 0
    while (p.next() != XmlPullParser.END_DOCUMENT) {
      when (p.eventType) {
        XmlPullParser.START_TAG -> when (localName(p.name)) {
          "t", "delText" -> inText = true
          "ins" -> insertions += 1
          "del" -> deletions += 1
          "tab" -> into.append('\t')
        }
        XmlPullParser.TEXT -> if (inText && into.length < MAX_TEXT_CHARS) into.append(p.text)
        XmlPullParser.END_TAG -> when (localName(p.name)) {
          "t", "delText" -> inText = false
          "p" -> into.append('\n')
        }
      }
    }
    return insertions to deletions
  }

  private fun parseProperties(bytes: ByteArray, into: MutableMap<String, String>) {
    val keys = setOf("creator", "lastModifiedBy", "created", "modified", "Company", "Manager", "title", "subject", "keywords")
    val p = parser(bytes)
    var current: String? = null
    while (p.next() != XmlPullParser.END_DOCUMENT) {
      when (p.eventType) {
        XmlPullParser.START_TAG -> current = localName(p.name).takeIf { it in keys }
        XmlPullParser.TEXT -> current?.let { key -> p.text.trim().takeIf { it.isNotEmpty() }?.let { into[key] = it.take(200) } }
        XmlPullParser.END_TAG -> current = null
      }
    }
  }

  private fun parseWorkbook(bytes: ByteArray, hidden: MutableList<String>) {
    val p = parser(bytes)
    while (p.next() != XmlPullParser.END_DOCUMENT) {
      if (p.eventType == XmlPullParser.START_TAG && localName(p.name) == "sheet") {
        var name = "Sheet"
        var state: String? = null
        for (i in 0 until p.attributeCount) {
          when (localName(p.getAttributeName(i))) {
            "name" -> name = p.getAttributeValue(i)
            "state" -> state = p.getAttributeValue(i)
          }
        }
        if (state == "hidden" || state == "veryHidden") hidden.add(name)
      }
    }
  }

  private fun countTags(bytes: ByteArray, tag: String): Int {
    val p = parser(bytes)
    var count = 0
    while (p.next() != XmlPullParser.END_DOCUMENT) {
      if (p.eventType == XmlPullParser.START_TAG && localName(p.name) == tag) count += 1
    }
    return count
  }

  // endregion

  companion object {
    private const val OCR_MAX_DIMENSION = 2048
    private const val MAX_ENTRY_BYTES = 16 * 1024 * 1024
    private const val MAX_ARCHIVE_BYTES = 64L * 1024 * 1024
    private const val MAX_TEXT_CHARS = 2_000_000

    fun readUpTo(input: InputStream, limit: Int): ByteArray {
      val out = ByteArrayOutputStream(min(limit, 64 * 1024))
      val buffer = ByteArray(64 * 1024)
      var remaining = limit
      while (remaining > 0) {
        val read = input.read(buffer, 0, min(buffer.size, remaining))
        if (read < 0) break
        out.write(buffer, 0, read)
        remaining -= read
      }
      return out.toByteArray()
    }
  }
}
