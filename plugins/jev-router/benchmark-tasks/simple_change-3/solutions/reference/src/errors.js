// The errors an upload can be refused with.

/** An upload is refused; `code` says why. */
export class UploadError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UploadError'
    this.code = code
  }
}

export const tooLarge = () => new UploadError('TOO_LARGE', 'File too large (max 25 MB)')
export const wrongType = (type) => new UploadError('WRONG_TYPE', `Files of type ${type} are not accepted`)
export const tooMany = (limit) => new UploadError('TOO_MANY', `You can keep at most ${limit} files`)
