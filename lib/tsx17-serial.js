/*jslint node: true, vars: true, nomen: true */
'use strict';

var Events = require("events");
var Serialport = require("serialport");
var Util = require("util");
var BuffersStream = require('my-buffers-stream');
var debug = require('debug')('tsx17:serial');
var debugRead = require('debug')('tsx17:serial:read');
var debugCmd = require('debug')('tsx17:serial:cmd');
var debugTimer = require('debug')('tsx17:serial:timer');

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
	var closed = false;

	var poolingRetry = 0;

	var timeout = setTimeout(function() {
		debug("tryBauds.Timeout !");
		timeout = undefined;

		var error = new Error("Timeout, bauds=" + bauds);
		error.code = "TIMEOUT";

		closePort(error);

	}, 1000 * 2);

	function closePort(error) {
		debug("tryBauds.closePort closed=", closed, " error", error);

		if (closed) {
			return;
		}
		closed = true;

		removeListeners();
		try {
			// debug("Close port");

			sp.close(function(error2) {
				if (error2) {
					debug("Close while invalid data, throws error ", error2);
					return callback(error || error2);
				}

				setTimeout(function() {
					callback(error);
				}, 1000);
			});

		} catch (x) {
			debug("Close exception", x);

			var error = new Error("Can not close");
			error.cause = x;
			callback(error);
		}
	}

	function dataListener(buffer) {
		if (closed) {
			return;
		}

		if (!Buffer.isBuffer(buffer)) {
			buffer = new Buffer(buffer, 'binary');
		}

		var b = buffer[0];

		if (b === ACK || b === EOT) {
			removeListeners();

			debug("Receive ACK/EOT ", buffer);

			if (resetBauds) {
				self.resetBauds(function(error) {
					var err = new Error("Bauds parameter was just resetted, bauds=" + bauds);
					err.code = 'RESET_BAUDS';

					closePort(err);
					return;
				});
				return;
			}

			return callback(null, sp);
		}

		debug("Invalid receive of ", buffer);

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
			var error = new Error("Invalid communication");
			error.code = "INVALID_COMMUNICATION";

			return closePort(error);
		}

		self.resetBauds(function(error) {
			if (error) {
				debug("Reset bauds throws error: ", error);

			} else {
				error = new Error("Bauds parameter was just resetted, bauds=" + bauds);
			}

			debug("Reset Bauds command sent !");

			removeListeners();

			setTimeout(function() {
				closePort(error);
			}, 500);
		});
	}
	sp.on('data', dataListener);

	function errorListener(error) {
		debug("Error for serial port", error);

		closePort(error);
	}
	sp.on('error', errorListener);

	function openListener(error) {
		if (closed) {
			return;
		}

		if (error) {
			debug("Open listener error", error);

			removeListeners();
			return callback(error);
		}

		self.serialWrite(POLLING_BUFFER, function(error) {
			if (error) {
				debug("open.polling ERROR", error);
			}
		});
	}
	sp.once("open", openListener);

	function removeListeners() {

		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}

		sp.removeListener('data', dataListener);
		sp.removeListener('error', errorListener);
		sp.removeListener('open', openListener);
	}

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

	debugCmd("Send PollingBuffer");
	var self = this;
	this.serialWrite(POLLING_BUFFER, function(error) {
		if (error) {
			debug("Write polling buffer error: " + error);
			return callback(error);
		}

		serialPort.drain(function(error) {
			if (error) {
				debug("Drain polling buffer error: ", error)
				return callback(error);
			}

			self.waitResult(function(error, packet) {
				if (error) {
					if (debug.enabled) {
						debug("sendPollingAndWait: Wait error=", error);
					}
					return callback(error);
				}

				if (debugCmd.enabled) {
					debugCmd("Wait result=", packet);
				}

				if (typeof (packet) === "object") {
					self.serialWrite([ ACK ], function(error) {
						if (error) {
							debug("Send ACK error: " + error);
							return callback(error);
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
			debug("Try 9600-1 returns ", error, sp);
			if (error) {
				if (error.code !== "TIMEOUT" && error.code !== "INVALID_COMMUNICATION") {
					return callback(error);
				}
			}
			if (sp) {
				return callback(error, sp);
			}

			self.tryBauds(19200, false, function(error, sp) {
				debug("Try 19200 returns ", error, sp);
				if (error) {
					if (error.code !== "TIMEOUT" && error.code !== "INVALID_COMMUNICATION") {
						return callback(error);
					}
				}
				if (sp) {
					return callback(error, sp);
				}

				self.tryBauds(9600, false, function(error, sp) {
					debug("Try 9600-2 returns ", error, sp);
					if (error) {
						if (error.code !== "TIMEOUT" && error.code !== "INVALID_COMMUNICATION") {
							return callback(error);
						}
					}
					if (sp) {
						return callback(error, sp);
					}

					self.tryBauds(300, true, function(error, sp) {
						debug("Try 300 returns ", error, sp);
						if (error) {
							if (error.code !== "TIMEOUT" && error.code !== "RESET_BAUDS") {
								return callback(error);
							}
						}

						self.tryBauds(9600, false, function(error, sp) {
							debug("Retry 9600-3 returns ", error, sp);

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
			return callback(new Error("Can not connect"));
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

		if (debugRead.enabled) {
			debugRead("Read data from serial ", buffer, " bufSize=", self.stream.bufferSize);
		}
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

	if (debugCmd.enabled) {
		debugCmd("Wait result ! bufferSize=", this.stream.bufferSize);
	}

	function readSTX() {
		var buf = self.stream.read(1);
		if (!buf || !buf.length) {
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

		if (!buf || !buf.length) {
			if (debugCmd.enabled) {
				debugCmd("Buf is empty size=" + this.stream.bufferSize);
			}
			break;
		}

		var b = buf[0];

		if (debugRead.enabled) {
			debugRead("First packet byte ", b);
		}

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

	var waiting = true;
	var timeoutId;

	function waitData() {
		if (!waiting) {
			return;
		}
		waiting = false;

		if (debugTimer.enabled) {
			debugTimer("waitResult: DATA RECEIVED now=" + Date.now() + " timeoutId=", timeoutId);
		}

		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}

		self.waitResult(callback);
	}

	timeoutId = setTimeout(function() {
		if (!waiting) {
			return;
		}
		waiting = false;
		self.stream.removeListener('bufferReady', waitData);

		if (debugTimer.enabled) {
			debugTimer("waitResult: timeout now=" + Date.now() + " timeoutId=", timeoutId);
		}

		var error = new Error('WaitResult Timeout (' + SERIAL_TIMEOUT + "ms)");
		error.code = "TIMEOUT";

		callback(error);
	}, SERIAL_TIMEOUT);

	if (debugTimer.enabled) {
		debugTimer("Set timeout now=" + Date.now() + " timeoutId=", timeoutId);
	}

	this.stream.once('bufferReady', waitData);
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

TSX17.prototype.reset = function(callback) {
	debug("Reseting ...");

	var self = this;
	this.close(function(error) {
		if (error) {
			debug("Reset.close ERROR", error);
		}

		self.open(function(error) {
			if (error) {
				debug("Reset.open ERROR", error);

			} else {
				debug("Reset success !");
			}

			callback(error);
		});
	});
};
