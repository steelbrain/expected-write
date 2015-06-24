# @Compiler-Output "../Dist/Main.js"

Promise = require('a-promise')
EventEmitter = require('events').EventEmitter
Buffer = require('buffer').Buffer

class ExpectedWrite extends EventEmitter
  constructor: (@stream) ->
    super
    @status = true
    @expected = null
    @expectedStream = 'both' # enum{ stdout, stderr, both }
    @callback = null
    @data = stdout: '', stderr: ''

    @stream.on 'close', =>
      @status = false
      @emit('end', @data)
    if @stream.stdout
      @stream.stdout.on 'data', (data) =>
        @data.stdout += data
        @validateExpected()
    else
      @stream.on 'data', (data) =>
        @data.stdout += data
        @validateExpected()
    @stream.stderr.on 'data', (data) =>
      @data.stderr += data
      @validateExpected()

  # Internal
  validateExpected: ->
    return unless @expected
    return unless @callback
    valid = false
    if @expectedStream isnt 'stderr'
      if @data.stdout.indexOf(@expected) isnt -1 then valid = 'stdout'
    if @expectedStream isnt 'stdout' and not valid
      if @data.stderr.indexOf(@expected) isnt -1 then valid = 'stderr'
    return unless valid
    content = @data[valid]
    callback = @callback
    @data = stdout: '', stderr: ''
    @callback = null
    @expected = null
    @expectedStream = 'both'
    callback(content)

  expect: (toExpect, expectedStream) ->
    return new Promise (Resolve) =>
      @expectedStream = expectedStream
      @expected = toExpect
      @callback = Resolve
      @validateExpected()

  write: (Content)->
    if @stream.stdin
      @stream.stdin.write Content
    else
      @stream.write Content
    @

  end: (Content = '')->
    if @stream.kill
      @stream.stdin.write(Content)
      @stream.kill()
    else
      @stream.end(Content)
    @onEnd()

  onEnd: ->
    return new Promise (Resolve) =>
      if @status
        @once('end', Resolve)
      else
        Resolve(@data)

module.exports = ExpectedWrite
