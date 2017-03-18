Expected-Write
===========

[![Greenkeeper badge](https://badges.greenkeeper.io/steelbrain/Expected-Write.svg)](https://greenkeeper.io/)
Expected-Write is a tiny Promise-based expect-and-write library. It's super simple to get going with it and it works on all kinds of streams and child processes.

#### SSH Example
```js
var SSHDriver = require('node-ssh')
var ExpectedWrite = require('expected-write')
var SSH = new SSHDriver({
  host: 'localhost',
  username: 'steel',
  privateKey: '/home/steel/.ssh/id_rsa'
})
SSH.connect().then(function(){
  return SSH.requestShell()
}).then(function(SSHShell){
  var E = new ExpectedWrite(SSHShell)
  E.write("sudo echo test\n").expect('[sudo] password')
    .then(function(Content)){
      console.log(Content) // [sudo] password for steel:
      E.write("mySecretPassword")
      return E.expect("test")
    })
    .then(function(Info){
      E.end()
    })
})
```

#### API
```js
enum StreamType { stdout, stderr, both }
class ExpectedWrite extends EventEmitter{
  expect(toExpect: String, expectedStream: StreamType): Promise
  write(Content: String): this
  end(?Content: String): Promise
  onEnd(): Promise
}
```

#### License
This project is licensed under the terms of MIT License. See the License file for more info.