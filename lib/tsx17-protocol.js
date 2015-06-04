/*jslint node: true, vars: true, nomen: true */
'use strict';

var semaphore = require('semaphore');
var util = require('util');
var debug = require('debug')('tsx17:protocol');

var NETWORK_DEFAULT = 0xf0;

var STATION_DEFAULT = 0xfe;

var GATE_DEFAULT = 0x01;

var MODULE_DEFAULT = 0x0fe;

var CHANNEL_DEFAULT = 0x00;

var CATEGORY_DEFAULT = 0x03;

var SEGMENT_DEFAULT = 0x07;

var ACK = 0x06; // Acquitement

var NACK = 0x15; // Non acquitement

var EOT = 0x04; // Pas de message disponible

var TSX17_protocol = function(tsx17, config) {
	config = config || {};
	this.config = config;
	this.tsx17 = tsx17;
	this._semaphore = semaphore(1);

	if (config.network === undefined) {
		config.network = NETWORK_DEFAULT;
	}

	if (config.station === undefined) {
		config.station = STATION_DEFAULT;
	}

	if (config.gate === undefined) {
		config.gate = GATE_DEFAULT;
	}

	if (config.module === undefined) {
		config.module = MODULE_DEFAULT;
	}

	if (config.channel === undefined) {
		config.channel = CHANNEL_DEFAULT;
	}

	if (config.category === undefined) {
		config.category = CATEGORY_DEFAULT;
	}

	if (config.segment === undefined) {
		config.segment = SEGMENT_DEFAULT;
	}
};

module.exports = TSX17_protocol;

TSX17_protocol.prototype._sync = function(func, callback) {
	var sem = this._semaphore;
	sem.take(function() {
		var left = false;

		try {
			func(function(error) {

				if (left) {
					throw new Error("Already left ???");
				}

				left = true;
				sem.leave();

				return callback.apply(this, arguments);
			});

		} catch (x) {
			console.error(x);
			if (!left) {
				sem.leave();
			}

			throw x;
		}
	});
};

TSX17_protocol.prototype._sendCommand = function(command, callback) {
	var tryCount = 0;
	var config = this.config;
	var self = this;

	function waitResponse() {
		self.tsx17.sendPollingAndWait(function(error, ret) {
			if (error) {
				debug("_sendCommand.waitResponse: error=", error);

				if (error.code === 'TIMEOUT') {
					setImmediate(self._sendCommand.bind(self, command, callback));
					return;
				}

				return callback(error);
			}

			if (ret === EOT) {
				return waitResponse();
			}

			if (ret === NACK) {
				// TODO RESET connection and send command

				debug("GET NACK");
			}

			return callback(null, ret);
		});
	}

	function sendCommand() {
		tryCount++;
		if (tryCount > 5) {
			return callback("Max try reached");
		}

		debug("Send command #" + tryCount + " ", command);

		self.tsx17.sendPacket(config, command, function(error) {
			if (error) {
				return callback("Send packet error: " + +util.inspect(error));
			}

			debug("Packet sent, waiting response ...");

			self.tsx17.waitResult(function(error, response) {
				debug("Wait result return response=", response, " error=", error);

				if (error) {
					if (error.code === 'TIMEOUT') {

						debug("_sendCommand.sendCommand()=>Timeout, reset tsx17", error);

						tsx17.reset(function(error) {
							if (error) {
								debug("_sendCommand.reset", error);

								callback(error);
							}
							setImmediate(sendCommand);
						});
						return;
					}

					return callback("Wait response error: " + util.inspect(error));
				}
				if (response === ACK) {
					setImmediate(waitResponse);
					return;
				}
				if (response === NACK) {
					debug("NACK retry");
					setImmediate(sendCommand);
					return;
				}

				debug("Unknown return code ", response);
				setImmediate(sendCommand);
			});
		});
	}

	sendCommand();
};

TSX17_protocol.prototype.readInfos = function(callback) {
	this._sendCommand([ 0x02, 0x03, 0x00, 0x00 ], function(error, ret) {
		if (error) {
			return callback(error);
		}

		callback(null, ret);
	});
};

TSX17_protocol.prototype._readDatas = function(type, offset, count, callback) {
	var buffer = [];
	buffer[0] = 0x36;
	buffer[1] = this.config.category;
	buffer[2] = type;
	buffer[3] = this.config.segment;
	buffer[4] = offset & 0xff;
	buffer[5] = (offset >> 8) & 0xff;
	buffer[6] = count & 0xff;
	buffer[7] = (count >> 8) & 0xff;

	this._sendCommand(buffer, function(error, ret) {
		if (error) {
			return callback(error);
		}

		callback(null, ret);
	});
};

TSX17_protocol.prototype.readWords = function(offset, count, callback) {
	var self = this;

	this._sync(function(callback) {
		self._readWords(offset, count, callback);
	}, callback);
}

TSX17_protocol.prototype._readWords = function(offset, count, callback) {
	var self = this;

	var cnt = count;
	if (cnt > 15) {
		cnt = 15;
	}

	// debug("ReadWords offset=", offset, "count=", count);

	this._readDatas(0x68, offset, cnt, function(error, ret) {

		// debug("ReadDatas RETURN error=", error, " ret=", ret);

		if (error) {
			if (error.code === 'TIMEOUT') {

			}
			return callback(error);
		}

		if (!ret.data || ret.data.length < 4 || ret.data[0] !== 0x66) {
			return callback("Invalid packet return ", ret.data);
		}

		var r = [];
		for (var i = 2; i < ret.data.length;) {
			r.push(ret.data[i++] | (ret.data[i++] << 8));
		}

		// debug("ReadDatas array=", r);

		if (cnt === count) {
			return callback(null, r);
		}

		self._readWords(offset + cnt, count - cnt, function(error, ret2) {
			if (error) {
				return callback(error);
			}

			var ret3 = r.concat(ret2);

			return callback(null, ret3);
		});
	});
};

TSX17_protocol.prototype.setWord = function(value, offset, callback) {
	var self = this;

	var buffer = [];
	buffer[0] = 0x14;
	buffer[1] = this.config.category;
	buffer[2] = offset & 0xff;
	buffer[3] = (offset >> 8) & 0xff;
	buffer[4] = value & 0xff;
	buffer[5] = (value >> 8) & 0xff;

	this._sync(function(callback) {

		self._sendCommand(buffer, function(error, ret) {

			if (error) {
				return callback(error);
			}

			if (!ret.data || !ret.data.length) {
				return callback("Invalid packet return ", ret.data);
			}

			if (ret.data[0] !== 0xFE) {
				return callback("Invalid return code " + ret.data[0]);
			}

			return callback(null, true);
		});
	}, callback);
};

TSX17_protocol.prototype.setWords = function(words, offset, count, callback) {
	var self = this;

	this._sync(function(callback) {
		self._setWords(words, offset, count, callback);

	}, callback);
};

TSX17_protocol.prototype._setWords = function(words, offset, count, callback) {
	var ret = [];

	var self = this;

	var cnt = count;
	if (cnt > 15) {
		cnt = 15;
	}

	var buffer = [];
	buffer[0] = 0x37;
	buffer[1] = this.config.category;
	buffer[2] = 0x68;
	buffer[3] = this.config.segment;
	buffer[4] = offset & 0xff;
	buffer[5] = (offset >> 8) & 0xff;
	buffer[6] = cnt & 0xff;
	buffer[7] = (cnt >> 8) & 0xff;

	var of = 8;
	for (var i = 0; i < cnt; i++) {
		var v = words[i];

		buffer[of++] = v & 0xff;
		buffer[of++] = (v >> 8) & 0xff;
	}

	// debug("ReadWords offset=", offset, "count=", count);

	this._sendCommand(buffer, function(error, ret) {

		debug("setWords.ReadDatas RETURN error=", error, " ret=", ret);

		if (error) {
			return callback(error);
		}

		if (!ret.data || !ret.data.length) {
			return callback("Invalid packet return ", ret.data);
		}

		if (ret.data[0] !== 0xFE) {
			return callback("Invalid return code " + ret.data[0]);
		}

		if (cnt === count) {
			return callback(null, true);
		}

		var newWords = words.slice(cnt);

		self._setWords(newWords, offset + cnt, count - cnt, callback);
	});
};
