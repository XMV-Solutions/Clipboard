var express = require('express');
var app = express();
var multer = require('multer');
var http = require('http').Server(app);
var https = require('https');
var uuid = require('node-uuid');
var io = require('socket.io')(http);
var fs = require('fs');
var getFolderSize = require('get-folder-size');
var request = require('request');

// Standards
var port = 3000;
var maxFileSizeString = "500M";
var maxUploadsFolderSizeString = "1G";
var dest = 'uploads/';

// Base64 Image to Baytes
function decodeBase64Image(dataString) 
{
	var matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
	var response = {};

	if (matches.length !== 3) {
		return new Error('Invalid input string');
	}

	response.type = matches[1];
	response.data = new Buffer(matches[2], 'base64');

	return response;
}

// filesize human readable to int
function getIntFileSize(hrFileSize) {

    String.prototype.replaceAll = function (search, replacement) {
        var target = this;
        return target.split(search).join(replacement);
    };

    hrFileSize = hrFileSize.replaceAll(/\s+/, "");
    hrFileSize = hrFileSize.replaceAll(/T/i, "MM");
    hrFileSize = hrFileSize.replaceAll(/G/i, "KM");
    hrFileSize = hrFileSize.replaceAll(/M/i, "KK");
    var intFileSize = hrFileSize.replaceAll(/K/i, "000");

    return intFileSize;

}
;
var maxFileSize = getIntFileSize(maxFileSizeString);
var maxUploadsFolderSize = getIntFileSize(maxUploadsFolderSizeString);


// Usage
process.argv.forEach(function (val, index, array) {
    var nextVal = "";

    try {
        nextVal = typeof array[index + 1] !== "undefined" ? array[index + 1] : "";
    } catch (ignore) {
    }

    switch (val) {
        case "-p":
        case "--port":
            if (parseInt(nextVal))
                port = parseInt(nextVal);
            else {
                console.log("Could'nt parse Port " + nextVal);
                process.exit(1);
            }
            break;

        case "-m":
        case "--maxFilesSize":
            var mInt = getIntFileSize(nextVal);
            if (parseInt(mInt)) {
                maxFileSizeString = nextVal;
                maxFileSize = parseInt(mInt);
            } else {
                console.log("Could'nt parse maxFilesSize " + nextVal);
                process.exit(2);
            }
            break;

        case "-u":
        case "--maxUploadsFolderSize":
            var mInt = getIntFileSize(nextVal);
            if (parseInt(mInt)) {
                maxUploadsFolderSizeString = nextVal;
                maxUploadsFolderSize = parseInt(mInt);
            } else {
                console.log("Could'nt parse maxUploadsFolderSize " + nextVal);
                process.exit(3);
            }
            break;

        case "-h":
            var path = require('path');
            var programName = path.basename(__filename);
            console.log("USAGE:\nnode " + programName + " [-p/--port {port}] [-m/--maxFilesSize {size}] [-u/--maxUploadsFolderSize {size of uploads folder before cleanup}]");
            process.exit(0);
            break;
        default:
            // ignore
    }
});

// Cleanup uploads directory on startup
function emptyUploadsDir() {
    fs.readdir(__dirname + '/uploads', function (err, file) {
        file.forEach(function (file) {
            fs.unlink(__dirname + '/uploads/' + file);
        });
    });
    console.log("cleaned up uploads directory");
}
;
emptyUploadsDir();

// User Counter per name space
var counters = [];

// Open Clipboardpage, start namespaced socket.io connection
app.get(/^((?!(?:[\/]+uploads?)|(?:[\/]+static)|(?:[\/]+favicon.ico)).*)$/, function (req, res) {
    var nsp = req._parsedUrl.pathname;
    if (typeof io.nsps[nsp] === "undefined") {
        // Generate new counter
        counters[nsp] = 0;
        io.of(nsp).on('connection', function (socket) {

            // Send counter info
            io.of(nsp).emit('connectionCount', {connections: ++counters[nsp]});

            // Build ChatBroadcaster
            socket.on('chat message', function (msg) {
                io.of(nsp).emit('chat message', msg);
            });
			
            // Build pasteImage
            socket.on('pasteImage', function (base64Image) {

				var imageBuffer = decodeBase64Image(base64Image);
				
				var extension = imageBuffer.type.split("/").pop();
				
				var uniq = uuid.v4();
				var filename = "image-" + uniq + "." + extension;
				var dest = "uploads/" + uniq;
				
				try	{
					require('fs').writeFile(dest, imageBuffer.data, function(){
						var fileInfos = {
							"originalname" : filename,
							"mimetype" : imageBuffer.type,
							"filename" : uniq,
							"pathname" : dest
						};
						console.log(fileInfos);
						io.of(nsp).emit('newFile', fileInfos);						
					})  
				} catch(error) {
					console.log('ERROR: ', error);
				}				
				
            });

            
            // Send counter info on disconnet
            socket.on('disconnect', function () {
                io.of(nsp).emit('connectionCount', {connections: --counters[nsp]});
            });
        });
    }
    res.sendFile(__dirname + '/index.html');
});
// Statics
app.use('/static', express.static('node_modules'));


var uploadDirSize = 0;
var upload = multer({dest: dest});

// File upload processor
app.post(/^\/+upload$/, upload.single('file'), function (req, res) {
    if (typeof req.body.uploadNameSpace !== "undefined") {
        
        // Get Folder Size
        getFolderSize(__dirname + '/uploads/', function (err, size) {
            if (err)
                var ignore;
            uploadDirSize = size;
        });

        if (req.file.size > maxFileSize) {
            io.of(req.body.uploadNameSpace).emit('fileTooBig', { maxFileSize: maxFileSizeString, file: req.file });
            fs.unlink(__dirname + '/uploads/' + req.file.filename);
            return res.status(429).send({});
        } else if (uploadDirSize + req.file.size > maxUploadsFolderSize) {
            io.of(req.body.uploadNameSpace).emit('all Files are deleted', maxUploadsFolderSizeString);
            emptyUploadsDir();
            return res.status(429).send({});
        } else {
			console.log(req.file);
            io.of(req.body.uploadNameSpace).emit('newFile', req.file);
            return res.status(200).send(req.file);
        }
    } else {
        console.log("This schould not happen 1: // File upload processor");
    }
});

// File download processor
app.get(/^\/+uploads\/.*$/, function (req, res) {
    res.download(__dirname + req._parsedUrl.pathname, req.param("orig"),
            function (err) {
                if (!err) {
                    fs.unlink(__dirname + req._parsedUrl.pathname);
                    io.of(req.param("nameSpace")).emit('delFile', req._parsedUrl.pathname.replace('/uploads/', ''));
                }
            });
});

// Server
http.listen(port, function () {
    console.log('listening on *:' + port);
});
