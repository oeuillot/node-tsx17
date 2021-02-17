var Tsx17Serial = require('./lib/tsx17-serial');
var Tsx17Protocol = require('./lib/tsx17-protocol');

module.exports = {
	Serial: Tsx17Serial,
	Protocol: Tsx17Protocol
};

/*
const serialport = require('serialport');
serialport.list().then((ports) => {

	ports.forEach(function (port) {
		console.log("  Port name='" + port.comName + "' pnpId='" +
			port.pnpId + "' manufacturer='" + port.manufacturer + "'");
	});
	console.log("End of list");
}, (error) => {
	console.log("List performs error : " + error);
	process.exit(0);
});
*/
