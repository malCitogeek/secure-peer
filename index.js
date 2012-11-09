var crypto = require('crypto');
var through = require('through');
var es = require('event-stream');

var createAck = require('./lib/ack');
var frame = require('./lib/frame');
var hash =require('./lib/hash');
var verify =require('./lib/verify');

module.exports = function (keys) {
    var group = 'modp5';
    var dh = crypto.getDiffieHellman(group);
    dh.generateKeys();
    dh.group = group;
    
    return function (cb) {
        return securePeer(dh, keys, cb);
    };
};

function securePeer (dh, keys, cb) {
    var stream, secret;
    
    function unframer (buf) {
        var uf = frame.unpack(stream.id.key.public, buf);
        if (uf === 'end') {
            if (stream && !destroyed) stream.emit('end');
            if (!destroyed) sec.emit('end');
            
            if (stream && !stream.closed) stream.emit('close');
            
            if (!sec.closed) sec.emit('close');
            return;
        }
        if (!uf) {
            stream.destroy();
            sec.destroy();
            return;
        }
        var msg = Buffer(uf[0], 'base64');
        
        var decrypt = crypto.createDecipher('aes-256-cbc', secret);
        var s = decrypt.update(String(msg)) + decrypt.final();
        stream.emit('data', Buffer(s));
    }
    
    var firstLine = true;
    var lines = [];
    
    var end = (function () {
        var sentEnd = false;
        return function end () {
            if (destroyed) return;
            if (sentEnd) return;
            sentEnd = true;
            sec.emit('data', '[]\n');
        }
    })();
    
    var sec = es.connect(es.split(), through(function (line) {
        if (!firstLine && lines) return lines.push(line);
        else if (!firstLine) return unframer(line);
        
        firstLine = false;
        
        try {
            var header = JSON.parse(line);
        } catch (e) { return sec.destroy() }
        
        sec.emit('header', header);
    }, end));
    
    var destroyed = false;
    sec.destroy = function () {
        if (!destroyed && !sec.closed) {
            sec.emit('close');
        }
        if (!destroyed && stream && !stream.closed) {
            stream.emit('close');
        }
        destroyed = true;
    };
    
    sec.on('close', function () { sec.closed = true });
    
    sec.on('accept', function (ack) {
        var pub = ack.payload.dh.public;
        secret = dh.computeSecret(pub, 'base64', 'base64');
        
        stream = through(write, end);
        stream.id = ack;
        stream.on('close', function () { stream.closed = true });
        
        function write (buf) {
            var encrypt = crypto.createCipher('aes-256-cbc', secret);
            var s = encrypt.update(String(buf)) + encrypt.final();
            sec.emit('data', frame.pack(keys.private, Buffer(s)));
        }
        
        sec.emit('connection', stream);
        
        var lines_ = lines;
        lines = undefined;
        lines_.forEach(unframer);
    });
    
    sec.once('header', function (meta) {
        var payload = JSON.parse(meta.payload);
        
        var ack = createAck(sec.listeners('identify').length);
        ack.key = payload.key;
        ack.outgoing = outgoing;
        ack.payload = payload;
        
        ack.on('accept', function () {
            sec.emit('accept', ack);
        });
        
        ack.on('reject', function () {
            sec.emit('close');
        });
        
        var v = verify(payload.key.public, meta.payload, meta.hash);
        if (!v) return ack.reject();
        
        sec.emit('identify', ack);
    });
    
    sec.on('pipe', function () {
        process.nextTick(sendOutgoing);
    });
    
    var outgoing;
    function sendOutgoing () {
        outgoing = JSON.stringify({
            key : {
                type : 'rsa',
                public : keys.public,
            },
            dh : {
                group : dh.group,
                public : dh.getPublicKey('base64')
            }
        });
        sec.emit('data', JSON.stringify({
            hash : hash(keys.private, outgoing),
            payload : outgoing
        }) + '\n');
    }
    
    if (typeof cb === 'function') sec.on('connection', cb);
    return sec;
};
