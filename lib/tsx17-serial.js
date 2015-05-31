/*jslint node: true, vars: true, nomen: true */
'use strict';

var Events = require("events");
var Serialport = require("serialport");
var Util = require("util");
var BuffersStream = require('my-buffers-stream');
var debug = require('debug')('tsx17:serial');
var debugRead = require('debug')('tsx17:serial:read');

var SERIAL_TIMEOUT = 1000 * 5;

var ACK = 0x06; // Acquitement

var NACK = 0x15; // Non acquitement

var DLE = 0x10; // Debut

var STX = 0x02; // Requête

var ENQ = 0x05; // Polling

var EOT = 0x04; // Pas de message disponible

var POLLING_BUFFER = new Buffer([ DLE, ENQ ]);

var RESET_BAUDS = new Buffer([ 0x06, 0x10, 0x02, 0x06, 0x30, 0xfe, 0x01, 0xfe, 0x00, 0x05, 0x4A ]);

var TSX17 = function(portName, callback) {
	this.portName = portName;

	callback(null, this);
};

Util.inherits(TSX17, Events.EventEmitter);
module.exports = TSX17;

TSX17.prototype.tryBauds = function(bauds, resetBauds, callback) {

	debug("Open serial port " + this.portName + " bauds=" + bauds + " reset=" + resetBauds);

	var sp = new Serialport.SerialPort(this.portName, {
		baudrate: bauds,
		databits: 8,
		stopbits: 1,
		parity: 'odd',
		rtscts: false
	});

	this.serialPort = sp;

	var self = this;

	var poolingRetry = 0;

	var timeout = setTimeout(function() {
		debug("Timeout !");

		var error = new Error("Timeout, bauds=" + bauds);
		error.code = "TIMEOUT";

		closePort(error);

	}, 1000 * 2);

	function removeListeners() {
		sp.removeListener('data', dataListener);
		sp.removeListener('error', errorListener);
	}

	function closePort(error) {
		removeListeners();
		try {
			// debug("Close port");

			sp.close(function(error2) {
				if (error2) {
					console.error("Close while invalid data, throws error ", error2);
					return callback(error || error2);
				}

				setTimeout(function() {
					callback(error);
				}, 1000);
			});

		} catch (x) {
			console.error(x);

			callback(new Error("Can not close"));
		}
	}

	function dataListener(buffer) {
		if (!Buffer.isBuffer(buffer)) {
			buffer = new Buffer(buffer, 'binary');
		}

		// debug("Receive ", buffer);
		var b = buffer[0];

		clearTimeout(timeout);

		if (b === ACK || b === EOT) {
			removeListeners();

			return callback(null, sp);
		}

		if (poolingRetry < 5) {
			poolingRetry++;

			debug("Retry pooling #" + poolingRetry);

			self.serialWrite(POLLING_BUFFER, function(error) {
				if (error) {
					console.error(error);
				}
			});

			return;
		}

		if (!resetBauds) {
			return closePort();
		}

		self.resetBauds(function(error) {
			if (error) {
				console.error("Reset bauds throws error: ", error);
			}

			// debug("Reset Bauds command sent !");

			closePort(error);
		});
	}
	sp.on('data', dataListener);

	function errorListener(error) {
		console.error("Error for serial port", error);

		clearTimeout(timeout);

		closePort(error);
	}
	sp.on('error', errorListener);

	sp.once("open", function(error) {
		if (error) {
			console.error(error);
			return callback(error);
		}

		self.serialWrite(POLLING_BUFFER, function(error) {
			if (error) {
				console.error(error);
			}
		});
	});
};

TSX17.prototype.serialWrite = function(buffer, callback) {
	var serialPort = this.serialPort;
	if (!serialPort) {
		return callback("Serial port is not opened");
	}
	if (Util.isArray(buffer)) {
		buffer = new Buffer(buffer);
	}

	// debug("Write ", buffer);

	serialPort.write(buffer, function(error) {
		if (error) {
			console.error(error);
			return callback(error);
		}

		serialPort.drain(callback);
	});
};

TSX17.prototype.resetBauds = function(callback) {
	this.serialWrite(RESET_BAUDS, callback);
};

TSX17.prototype.sendPollingAndWait = function(callback) {
	var serialPort = this.serialPort;
	if (!serialPort) {
		return callback("Serial port is not opened");
	}

	debug("Send PollingBuffer");
	var self = this;
	this.serialWrite(POLLING_BUFFER, function(error) {
		if (error) {
			return callback("Write polling buffer error: " + error);
		}

		serialPort.drain(function(error) {
			if (error) {
				return callback("Drain polling buffer error: " + error);
			}

			self.waitResult(function(error, packet) {
				if (error) {
					if (debug.enabled) {
						debug("Wait error=", error);
					}
					return callback("Wait result error: " + error);
				}

				if (debug.enabled) {
					debug("Wait result=", packet);
				}

				if (typeof (packet) === "object") {
					self.serialWrite([ ACK ], function(error) {
						if (error) {
							return callback("Send ACK error: " + error);
						}

						return callback(null, packet);
					});
					return;
				}

				callback(null, packet);
			});
		});

	});
};

TSX17.prototype.open = function(callback) {
	var self = this;

	function try19200(callback) {

		self.tryBauds(9600, false, function(error, sp) {
			if (error) {
				debug("Try 9600-1 returns ", error);
				if (error.code !== "TIMEOUT") {
					return callback(error);
				}
			}
			if (sp) {
				return callback(error, sp);
			}

			self.tryBauds(19200, false, function(error, sp) {
				if (error) {
					debug("Try 19200 returns ", error);
					if (error.code !== "TIMEOUT") {
						return callback(error);
					}
				}
				if (sp) {
					return callback(error, sp);
				}

				self.tryBauds(9600, false, function(error, sp) {
					if (error) {
						debug("Try 9600-2 returns ", error);
						if (error.code !== "TIMEOUT") {
							return callback(error);
						}
					}
					if (sp) {
						return callback(error, sp);
					}

					self.tryBauds(300, true, function(error, sp) {
						if (error) {
							debug("Try 300 returns ", error);
							if (error.code !== "TIMEOUT") {
								return callback(error);
							}
						}

						self.tryBauds(9600, false, function(error, sp) {
							if (error) {
								debug("Retry 9600 returns ", error);
								if (error.code !== "TIMEOUT") {
									return callback(error);
								}
							}

							return callback(error, sp);
						});
					});
				});
			});
		});
	}

	return try19200(function(error, sp) {
		if (error) {
			try19200(function(error, sp) {
				if (error) {
					return callback(error);
				}

				self.installPort(sp, callback);
			});
			return;
		}

		if (!sp) {
			return callback("Can not connect");
		}
		self.installPort(sp, callback);
	});
};

TSX17.prototype.installPort = function(sp, callback) {
	// debug("Install port ...");
	this.serialPort = sp;

	this.stream = new BuffersStream();

	var self = this;
	sp.on("data", function(buffer) {
		if (!Buffer.isBuffer(buffer)) {
			buffer = new Buffer(buffer, 'binary');
		}

		self.stream.write(buffer);

		debug("Read data from serial ", buffer, " bufSize=", self.stream.bufferSize);
	});

	sp.on("error", function(error) {
		console.error("Serial error ", error);

		self.emit("error", error);
	});

	this.emit("open");
	/*
	 * this.on("processData", function() { self.readData(); });
	 * 
	 * this.readData();
	 */

	this.sendPollingAndWait(function(error) {
		if (error) {
			return callback(error);
		}
		self.sendPollingAndWait(callback);
	});
};

TSX17.prototype.close = function(callback) {
	if (!this.serialPort) {
		return callback();
	}

	this.emit("close");

	var self = this;
	this.serialPort.close(function(error) {
		self.serialPort = undefined;

		return callback(error);
	});
};

TSX17.prototype.waitResult = function(callback) {
	var self = this;

	debug("Wait result ! bufferSize=" + this.stream.bufferSize);

	function waitData() {
		clearTimeout(timeoutId);
		self.waitResult(callback);
	}

	function readSTX() {
		var buf = self.stream.read(1);
		if (!buf) {
			self.stream.once('bufferReady', readSTX);
			return;
		}

		if (buf[0] !== STX) {
			var error = new Error("INVALID DLE/STX protocol");
			error.code = "INVALID_DLE/STX";

			return callback(error);
		}

		self.processDLE(callback);
	}

	for (;;) {
		var buf = this.stream.read(1);
		if (debugRead.enabled) {
			debugRead("ProcessData input=", buf);
		}

		if (!buf) {
			debug("Buf is empty size=" + this.stream.bufferSize);
			break;
		}

		var b = buf[0];

		debugRead("First packet byte ", b);

		if (b === ACK || b === NACK || b === EOT) {
			callback(null, b);
			return;
		}

		if (b === DLE) {
			readSTX();
			return;
		}

		debug("Unknown code ", buf, " wait another ...");
	}

	var timeoutId = setTimeout(function() {
		self.stream.removeListener('bufferReady', waitData);
		var error = new Error('WaitResult Timeout (' + SERIAL_TIMEOUT + "ms)");
		error.code = "TIMEOUT";

		callback(error);
	}, SERIAL_TIMEOUT);

	this.stream.once('bufferReady', function() {
		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = 0;
		}

		self.waitResult(callback);
	});
};

TSX17.prototype.readDLEByte = function() {
	var stream = this.stream;

	var b = stream.peek(0);
	if (b < 0) {
		return -1;
	}
	if (b !== DLE) {
		stream.skip(1);
		return b;
	}

	var b2 = stream.peek(1);
	if (b2 < 0) {
		return -1;
	}

	stream.skip(2);

	if (b2 === DLE) {
		return DLE;
	}

	throw new Error("INVALID DLE format");
};

TSX17.prototype.processDLE = function(callback) {
	var stream = this.stream;

	var len = this.readDLEByte();
	if (len < 0) {
		this.stream.once('bufferReady', this.processDLE.bind(this, callback));
		return;
	}

	var buf = new Buffer(len);
	var pos = 0;

	var self = this;
	function loadContent() {
		for (; pos < len;) {
			var b = stream.peek(0);
			if (b < 0) {
				self.stream.once('bufferReady', loadContent);
				return;
			}
			if (b === DLE) {
				var b2 = stream.peek(1);
				if (b2 < 0) {
					self.stream.once('bufferReady', loadContent);
					return;
				}
				if (b2 !== DLE) {
					debug("INVALID FORMAT !");
				}

				stream.skip(2);

				buf[pos++] = b;
				continue;
			}

			stream.skip(1);
			buf[pos++] = b;
		}

		var bcc = stream.peek(0);
		if (bcc < 0) {
			self.stream.once('bufferReady', loadContent);
			return;
		}

		stream.skip(1);

		// debug("Process DLEPacket bcc=", bcc, "Buf=", buf);

		self.processDLEPacket(buf, len, bcc, callback);
	}

	loadContent();
};

TSX17.prototype.processDLEPacket = function(buffer, len, bcc, callback) {
	var packet = {
		network: buffer[0],
		station: buffer[1],
		gate: buffer[2],
		module: buffer[3],
		channel: buffer[4],
		dataLength: len,
		data: buffer.slice(5, len),
		bcc: bcc
	};

	callback(null, packet);
};

TSX17.prototype.sendPacket = function(infos, datas, callback) {

	var buf = new Buffer((datas.length + 9) * 2);
	var offset = 0;
	var bcc = 0;

	function write(c) {
		if (c === DLE) {
			buf[offset++] = c;
			bcc += c;
		}
		buf[offset++] = c;
		bcc += c;
	}

	buf[offset++] = DLE;
	bcc += DLE;
	write(STX);

	write(datas.length + 5);
	write(infos.network);
	write(infos.station);
	write(infos.gate);
	write(infos.module);
	write(infos.channel);

	for (var i = 0; i < datas.length; i++) {
		var c = datas[i];

		write(c);
	}

	write(bcc & 0xff);

	buf = buf.slice(0, offset);

	debug("Command ready, write serial ", buf);

	this.serialWrite(buf, callback);
};
