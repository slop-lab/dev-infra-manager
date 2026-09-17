const fs = require("node:fs")
const path = require("node:path")

const fault = process.env.WORKSPACE_USER_SETUP_FAULT
if (fault !== undefined) {
  const original = {
    closeSync: fs.closeSync,
    fsyncSync: fs.fsyncSync,
    openSync: fs.openSync,
    renameSync: fs.renameSync,
    writeFileSync: fs.writeFileSync,
  }
  const temporaryPattern = /^\.(?:opencode\.jsonc?|omo\.jsonc)\.\d+\.[0-9a-f]{12}\.tmp$/
  const targetDescriptors = new Set()
  let renameCount = 0

  function isTargetTemporary(filePath) {
    return typeof filePath === "string" && temporaryPattern.test(path.basename(filePath))
  }

  function fail(operation) {
    const error = new Error(`injected workspace setup ${operation} failure`)
    error.code = "EIO"
    error.errno = -5
    error.syscall = operation
    throw error
  }

  fs.openSync = function (filePath, flags, mode) {
    const descriptor = original.openSync.call(fs, filePath, flags, mode)
    if (isTargetTemporary(filePath)) targetDescriptors.add(descriptor)
    return descriptor
  }

  fs.writeFileSync = function (file, data, options) {
    if (fault === "write" && targetDescriptors.has(file)) fail("write")
    return original.writeFileSync.call(fs, file, data, options)
  }

  fs.fsyncSync = function (descriptor) {
    if (fault === "fsync" && targetDescriptors.has(descriptor)) fail("fsync")
    return original.fsyncSync.call(fs, descriptor)
  }

  fs.closeSync = function (descriptor) {
    if (fault === "close" && targetDescriptors.has(descriptor)) {
      targetDescriptors.delete(descriptor)
      original.closeSync.call(fs, descriptor)
      fail("close")
    }
    targetDescriptors.delete(descriptor)
    return original.closeSync.call(fs, descriptor)
  }

  fs.renameSync = function (oldPath, newPath) {
    if (isTargetTemporary(oldPath)) {
      renameCount += 1
      if (fault === "second-rename" && renameCount === 2) fail("rename")
    }
    return original.renameSync.call(fs, oldPath, newPath)
  }
}
