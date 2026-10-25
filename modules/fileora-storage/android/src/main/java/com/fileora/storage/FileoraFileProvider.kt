package com.fileora.storage

import androidx.core.content.FileProvider

/** Dedicated provider so Fileora's share/open grants never collide with other libraries' providers. */
class FileoraFileProvider : FileProvider()
