'use strict';

/* Dependencies */
const fs = require('fs');
const get = require('request').get;
const path = require('path');
const isSvg = require('is-svg');
const isUrl = require('is-url');
const merge = require('lodash.merge');
const debug = require('debug')('fe-packager');
const Promise = require('bluebird');
const chokidar = require('chokidar');
const CleanCss = require('clean-css');
const fileType = require('file-type');
const Throttle = require('generic-throttle');
const isInvalidPath = require('is-invalid-path');
const JavaScriptObfuscator = require('javascript-obfuscator');

/* Functions */
const attemptMinify = (type, code, options) => {
	return new Promise((resolve, reject) => {
		const _min = () => {
			switch(type){
				case 'js':  return minifyJs(code, options.js);
				case 'css': return minifyCss(code, options.css);
				default:    return Promise.resolve(code);
			}
		};

		return _min().then(resolve).catch(() => {
			return resolve(code);
		});
	});
};

const bundle = (sources, destination, options, reqOptions) => {
	if(!options){
		options = {};
	}

	const target = fs.createWriteStream(destination);

	return loopFiles(sources, target, options, reqOptions).then(() => {
		target.end();

		if(!options.watch){
			return;
		}

		return watch(sources, destination, options, reqOptions);
	});
};

const cleanseResults = (results) => {
	results.code = results.code.replace(/\/\/\# sourceMappingURL\=.*\.map\s*/, '').trim();

	return results;
};

const downloadFile = (url, reqOptions) => {
	return new Promise((resolve, reject) => {
		get(merge({
			url: url,
			encoding: null
		}, reqOptions || {}), (err, response, body) => {
			if(err){
				return reject(err);
			}

			resolve(new Buffer(body));
		});
	});
};

const encodeExternalResources = (code, source) => {
	return new Promise((resolve, reject) => {
		const matches = code.match(/url\s*\((\s*\'?\"?[^\s\"\']*\'?\"?\s*)\)/g);

		if(!matches){
			return resolve(code);
		}

		return Promise.each(matches, (match) => {
			const matchSet = match.match(/url\s*\(\s*\'?\"?([^\s\"\']*)\'?\"?\s*\)/);
			const url = matchSet[1].trim();
			const replace = (file) => {
				let type = fileType(file);

				if(!type){
					if(isSvg(file.toString('utf-8'))){
						type = {
							mime: 'image/svg+xml'
						}
					}
				}

				code = code.replace(match, [
					'url(\'',
						'data:',
						type.mime,
						';charset=utf-8;',
						'base64,',
						file.toString('base64'),
					'\')'
				].join(''));

				return;
			};

			if(url.match(/^data\:/)){
				return;
			}else
			if(url.match(/^https?:\/\//)){
				return downloadFile(url).then(replace);
			}else{
				return readFile(path.join(path.dirname(source), url)).then(replace);
			}
		}).then(() => {
			return resolve(code);
		}).catch((err) => {
			debug(err);

			return resolve(code);
		});
	});
};

const getFile = (source, reqOptions) => {
	return new Promise((resolve, reject) => {
		const basefile = path.basename(source);

		if(isUrl(source)){
			debug('Downloading ' + basefile + '...');

			return downloadFile(source, reqOptions).then(resolve).catch(reject);
		}

		debug('Reading ' + basefile + '...');

		return readFile(source).then(resolve).catch(reject);
	});
};

const loopFiles = (sources, target, options, reqOptions) => {
	return Promise.each(sources, (source) => {
		const basefile = (typeof(source) !== 'object' ? path.basename(source) : source.map((file) => {
			return path.basename(file);
		}).join(', '));

		return processSource(source, target, reqOptions).then((results) => {
			results = cleanseResults(results);

			if(results.ext === 'js'){
				return results;
			}

			return encodeExternalResources(results.code, source).then((code) => {
				results.code = code;

				return results;
			});
		}).then((results) => {
			const isProd = options.minify || (process.env.hasOwnProperty('NODE_ENV') && !!process.env.NODE_ENV.match(/production/));

			if(!isProd || (isProd && !results.minify)){
				return results.code;
			}

			debug('Minifying ' + basefile + '...');

			return attemptMinify(results.ext, results.code, options);
		}).then((results) => {
			debug('Writing ' + basefile + '...');

			target.write(results + '\n');

			return;
		});
	});
};

const minifyCss = (data, options) => {
	return new Promise((resolve, reject) => {
		try {
			const result = new CleanCss(merge({}, options || {})).minify(data);

			if(result.errors && result.errors.length){
				return reject(result.errors[0]);
			}

			resolve(result.styles);
		}catch(err){
			reject(err);
		}
	});
};

const minifyJs = (data, options) => {
	return new Promise((resolve, reject) => {
		try {
			const result = JavaScriptObfuscator.obfuscate(data, merge({
				compact: true,
				controlFlowFlattening: true,
				controlFlowFlatteningThreshold: 1,
				deadCodeInjection: false,
				deadCodeInjectionThreshold: 0,
				debugProtection: false,
				debugProtectionInterval: false,
				disableConsoleOutput: false,
				log: false,
				mangle: false,
				renameGlobals: false,
				rotateStringArray: true,
				selfDefending: true,
				stringArray: true,
				stringArrayEncoding: 'rc4',
				stringArrayThreshold: 1,
				unicodeEscapeSequence: false
			}, options || {}));

			resolve(result.getObfuscatedCode());
		}catch(err){
			reject(err);
		}
	});
};

const parseFile = (source, target, reqOptions) => {
	return new Promise((resolve, reject) => {
		if(!isUrl(source) && isInvalidPath(source)){
			try {
				const parts = target.path.split('.');

				return resolve(wrapInComment(parts[parts.length - 1], source));
			}catch(err){
				return reject(err);
			}
		}

		return getFile(source, reqOptions).then((buffer) => {
			return buffer.toString('utf8');
		}).then(resolve).catch(() => {
			try {
				const parts = target.path.split('.');

				return resolve(wrapInComment(parts[parts.length - 1], source));
			}catch(err){
				return reject(err);
			}
		});
	});
};

const processSource = (source, target, reqOptions) => {
	if(typeof(source) !== 'object'){
		return parseFile(source, target, reqOptions).then((code) => {
			const parts = source.split('.');

			return {
				code: code,
				minify: !isInvalidPath(source) && parts[parts.length - 2] !== 'min',
				ext: parts[parts.length - 1]
			};
		});
	}

	return Promise.reduce(source, (code, file) => {
		return parseFile(file, target, reqOptions).then((results) => {
			return code + '\n' + results;
		});
	}, '').then((code) => {
		const parts = target.path.split('.');

		return {
			code: code,
			minify: parts[parts.length - 2] !== 'min',
			ext: parts[parts.length - 1]
		};
	});
};

const readFile = (filepath) => {
	return new Promise((resolve, reject) => {
		let readStream = fs.createReadStream(filepath);
		let chunks = [];

		readStream.on('error', reject);

		readStream.on('data', (chunk) => {
			chunks.push(chunk);
		});

		readStream.on('close', () => {
			resolve(Buffer.concat(chunks));
		});
	});
};

const watch = (sources, destination, options, reqOptions) => {
	const throttle = new Throttle(1);

	const watcher = chokidar.watch(sources, merge({
		persistent: true,
		ignoreInitial: true
	}, options || {}));

	const _bundle = function(){
		debug('Change detected. Starting bundling...');

		return throttle.acquire((resolve, reject) => {
			throttle.clear();

			return bundle(sources, destination, options, reqOptions);
		});
	};

	watcher.on('add', _bundle);
	watcher.on('change', _bundle);
	watcher.on('unlink', _bundle);
	watcher.on('addDir', _bundle);
	watcher.on('unlinkDir', _bundle);

	debug('Watching', sources);

	return Promise.resolve();
};

const wrapInComment = (type, code) => {
	switch(type){
		case 'js':
		case 'css':
			return [
				'/*!',
					code,
				'*/'
			].join('\n');
		case 'html':
		default:
			return [
				'<!--',
					code,
				'-->'
			].join('\n');
	}
};

/* Export */
module.exports = bundle;
