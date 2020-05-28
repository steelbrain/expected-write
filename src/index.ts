import invariant from 'assert'
import { Readable, Writable } from 'stream'

const DEFAULT_TIMEOUT = 10 * 1000 // 10s
const DEFAULT_ENCODING: BufferEncoding = 'utf8'
const EXPECT_DUPLICATE_MESSAGE = 'Cannot expect two things at once. Please wait for first expectation to complete'

interface Options {
  encoding: BufferEncoding
  stdout: InstanceType<typeof Readable>
  stderr: InstanceType<typeof Readable> | null
  stdin: InstanceType<typeof Writable> | null
  timeout: number
}

interface ExpectedWrite {
  clear(): this
  clearError(): this
  write(contents: string | Buffer): this

  expect(contents: string, timeout?: number, ignoreStderr?: boolean): Promise<string>
  expectLine(timeout?: number, ignoreStderr?: boolean): Promise<string>

  expectError(contents: string, timeout?: number, ignoreStdout?: boolean): Promise<string>
  expectErrorLine(timeout?: number, ignoreStdout?: boolean): Promise<string>

  waitEnd(timeout?: number): Promise<void>
  dispose(): void
}

type ExpectationType =
  | 'stdout-safe'
  | 'stdout-unsafe'
  | 'stdout-safe-newline'
  | 'stdout-unsafe-newline'
  | 'stderr-safe'
  | 'stderr-unsafe'
  | 'stderr-safe-newline'
  | 'stderr-unsafe-newline'

type Expectation<T> = {
  type: ExpectationType
  contents: T
  resolve(contents: string): void
  reject(err: Error): void
}

// Stolen from https://github.com/sindresorhus/is-stream/blob/3750505b0727f6df54324784fe369365ef78841e/index.js#L3
// Licensed under the MIT License
function isStream(obj: any): boolean {
  return obj && typeof obj === 'object' && typeof obj.pipe === 'function'
}

function getTimedPromise<T>(
  timeout: number,
  callback: (resolve: (value: T) => void, reject: (err: Error) => void) => void,
): Promise<T> {
  return new Promise(function(resolve, reject) {
    const timerId = setTimeout(function() {
      reject(new Error('Operation timed out'))
    }, timeout)

    callback(
      function(value) {
        clearTimeout(timerId)
        resolve(value)
      },
      function(err) {
        clearTimeout(timerId)
        reject(err)
      },
    )
  })
}

class UnexpectedContentsError extends Error {
  constructor(public contents: string, stream: 'stdout' | 'stderr') {
    super(`Unexpected contents on ${stream}`)
  }
}

function getExpectedWrite(givenOptions: Partial<Options>): ExpectedWrite {
  invariant(givenOptions && typeof givenOptions === 'object', 'options must be a valid object')
  invariant(
    givenOptions.encoding == null || typeof givenOptions.encoding === 'string',
    'options.encoding must be null or a valid string',
  )
  invariant(isStream(givenOptions.stdout), 'options.stdout must be a valid stream')
  invariant(givenOptions.stderr == null || isStream(givenOptions.stderr), 'options.stderr must be null or a valid stream')
  invariant(givenOptions.stdin == null || isStream(givenOptions.stdin), 'options.stdin must be null or a valid stream')
  invariant(
    givenOptions.timeout == null || typeof givenOptions.timeout === 'number',
    'options.timeout must be null or a valid number',
  )

  let stdoutEnded = false
  let stdoutContents = ''
  let stderrContents = ''
  let expectation: Expectation<any> | null = null

  const options: Options = {
    encoding: givenOptions.encoding == null ? DEFAULT_ENCODING : givenOptions.encoding,
    stdout: givenOptions.stdout as Options['stdout'],
    stderr: givenOptions.stderr == null ? null : givenOptions.stderr,
    stdin: givenOptions.stdin == null ? null : givenOptions.stdin,
    timeout: givenOptions.timeout == null ? DEFAULT_TIMEOUT : givenOptions.timeout,
  }

  function handleChunkTick() {
    if (expectation != null && expectation.type.startsWith('stdout')) {
      if (expectation.type.startsWith('stdout-safe')) {
        if (stderrContents.length > 1) {
          expectation.reject(new UnexpectedContentsError(stderrContents, 'stderr'))
          expectation = null
          stderrContents = ''
          return
        } // Else Ignore stderr if no contents
      } // Else Ignore stderr if type set to unsafe

      if (expectation.type.endsWith('newline')) {
        // Handle new line stuff
        const idx = stdoutContents.indexOf('\n')
        if (idx !== -1) {
          const slicedContents = stdoutContents.slice(0, idx)
          expectation.resolve(slicedContents)
          expectation = null
          // +1 with idx to omit the newline character
          stdoutContents = stdoutContents.slice(idx + 1)
        } // Else keep waiting
        return
      }

      const minLength = Math.min(expectation.contents.length, stdoutContents.length)
      const slicedContents = stdoutContents.slice(0, minLength)

      if (expectation.contents.slice(0, minLength) === slicedContents) {
        // Both are matching so far
        if (minLength === expectation.contents.length) {
          // We've got what we're looking for
          expectation.resolve(slicedContents)
          expectation = null
          stdoutContents = stdoutContents.slice(minLength)
        } // Else keep waiting
      } else {
        expectation.reject(new UnexpectedContentsError(stdoutContents, 'stdout'))
        expectation = null
        stdoutContents = ''
      }
    }

    if (expectation != null && expectation.type.startsWith('stderr')) {
      if (expectation.type.startsWith('stderr-safe')) {
        if (stdoutContents.length > 1) {
          expectation.reject(new UnexpectedContentsError(stdoutContents, 'stdout'))
          expectation = null
          stdoutContents = ''
          return
        } // Else Ignore stderr if no contents
      } // Else Ignore stderr if type set to unsafe

      if (expectation.type.endsWith('newline')) {
        // Handle new line stuff
        const idx = stderrContents.indexOf('\n')
        if (idx !== -1) {
          const slicedContents = stderrContents.slice(0, idx)
          expectation.resolve(slicedContents)
          expectation = null
          // +1 with idx to omit the newline character
          stderrContents = stderrContents.slice(idx + 1)
        } // Else keep waiting
        return
      }

      const minLength = Math.min(expectation.contents.length, stderrContents.length)
      const slicedContents = stderrContents.slice(0, minLength)

      if (expectation.contents.slice(0, minLength) === slicedContents) {
        // Both are matching so far
        if (minLength === expectation.contents.length) {
          // We've got what we're looking for
          expectation.resolve(slicedContents)
          expectation = null
          stderrContents = stderrContents.slice(minLength)
        } // Else keep waiting
      } else {
        expectation.reject(new UnexpectedContentsError(stderrContents, 'stderr'))
        expectation = null
        stderrContents = ''
      }
    }
  }

  function stdoutEndListener() {
    stdoutEnded = true
  }
  function stdoutDataListener(chunk: Buffer | string) {
    const contents = typeof chunk !== 'string' ? chunk.toString(options.encoding) : chunk
    stdoutContents += contents
    handleChunkTick()
  }
  function stderrDataListener(chunk: Buffer | string) {
    const contents = typeof chunk !== 'string' ? chunk.toString(options.encoding) : chunk
    stderrContents += contents
    handleChunkTick()
  }

  function setExpectation<Input>(timeout: number, expectationType: ExpectationType, contents: Input): Promise<string> {
    invariant(expectation === null, EXPECT_DUPLICATE_MESSAGE)
    return getTimedPromise(timeout, function(resolve, reject) {
      expectation = {
        type: expectationType,
        contents,
        resolve,
        reject,
      }
    })
  }

  const expectedWrite: ExpectedWrite = {
    clear() {
      stdoutContents = ''
      return this
    },
    clearError() {
      stderrContents = ''
      return this
    },
    write(contents) {
      invariant(options.stdin, 'options.stdin must be defined before using write()')
      invariant(
        contents && (typeof contents === 'string' || Buffer.isBuffer(contents)),
        'contents must be a valid string or Buffer',
      )
      options.stdin!.write(contents)

      return this
    },

    expect(contents: string, timeout: number = options.timeout, ignoreStderr: boolean = false): Promise<string> {
      invariant(typeof contents === 'string', 'contents must be a valid string')
      invariant(typeof timeout === 'number', 'timeout must be a valid number')

      const expectationType = ignoreStderr ? 'stdout-unsafe' : 'stdout-safe'
      return setExpectation<string>(timeout, expectationType, contents)
    },
    expectLine(timeout: number = options.timeout, ignoreStderr: boolean = false): Promise<string> {
      invariant(typeof timeout === 'number', 'timeout must be a valid number')

      const expectationType = ignoreStderr ? 'stdout-unsafe-newline' : 'stdout-safe-newline'
      return setExpectation<null>(timeout, expectationType, null)
    },

    expectError(contents: string, timeout: number = options.timeout, ignoreStdout: boolean = false): Promise<string> {
      invariant(typeof contents === 'string', 'contents must be a valid string')
      invariant(typeof timeout === 'number', 'timeout must be a valid number')

      const expectationType = ignoreStdout ? 'stderr-unsafe' : 'stderr-safe'
      return setExpectation<string>(timeout, expectationType, contents)
    },
    expectErrorLine(timeout: number = options.timeout, ignoreStdout: boolean = false): Promise<string> {
      invariant(typeof timeout === 'number', 'timeout must be a valid number')

      const expectationType = ignoreStdout ? 'stderr-unsafe-newline' : 'stderr-safe-newline'
      return setExpectation<null>(timeout, expectationType, null)
    },

    waitEnd(timeout: number = options.timeout): Promise<void> {
      invariant(typeof timeout === 'number', 'timeout must be a valid number')

      return getTimedPromise(timeout, function(resolve) {
        if (stdoutEnded) {
          resolve()
        } else {
          options.stdout.once('end', resolve)
        }
      })
    },
    dispose() {
      options.stdout.removeListener('end', stdoutEndListener)
      options.stdout.removeListener('data', stdoutDataListener)
      if (options.stderr) {
        options.stderr.removeListener('data', stderrDataListener)
      }
    },
  }

  options.stdout.once('end', stdoutEndListener)
  options.stdout.on('data', stdoutDataListener)
  if (options.stderr) {
    options.stderr.on('data', stderrDataListener)
  }

  return expectedWrite
}

exports = getExpectedWrite
