// TypeScript integration for Meteor
// Copyright 2015 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

var ts = Npm.require("typescript");
var path = Npm.require("path");
var fs = Npm.require("fs");
var crypto = Npm.require("crypto");


//
// TSDocument interface
//

function TSDocument(name, propertyPackers) {
    this.name = name;
    this.nameOnDisk = crypto.createHash("md5").update(name).digest("hex") + TSDocument.fileExtension;
    this.references = [];
    this.properties = {};
    this.lastVersion = false;
    this.modified = false;
    this.isEmpty = true;
    this._propertiesEncoded = {};
    this._propertyPackers = propertyPackers;
}

TSDocument.fileExtension = ".tscache";

TSDocument.prototype._packProperty = function (propertyName, value) {
    if (this._propertyPackers.hasOwnProperty(propertyName)) {
        var packinfo = this._propertyPackers[propertyName];
        return packinfo.pack(value);
    }
    else {
        return value;
    }
};

TSDocument.prototype._unpackProperty = function (propertyName, value) {
    if (this._propertyPackers.hasOwnProperty(propertyName)) {
        var packinfo = this._propertyPackers[propertyName];
        return packinfo.unpack(value);
    }
    else {
        return value;
    }
};

TSDocument.prototype.importDiskDocument = function (diskDocument) {
    var self = this;

    this.references = diskDocument.references;
    this.properties = unpackProperties(diskDocument.properties);
    this._propertiesEncoded = diskDocument.properties;
    this.lastVersion = diskDocument.lastVersion;
    this.modified = false;
    this.isEmpty = false;

    function unpackProperties(properties) {
        // Runs each property through an unpacker function registered for its name
        var result = {};
        Object.keys(properties).forEach(function (propertyName) {
            result[propertyName] = self._unpackProperty(propertyName, properties[propertyName]);
        });
        return result;
    }
};

TSDocument.prototype.toDiskDocument = function () {
    return {
        name: this.name,
        references: this.references,
        properties: this._propertiesEncoded,
        lastVersion: this.lastVersion
    };
};

TSDocument.prototype.reset = function () {
    this.references = [];
    this.properties = {};
    this._propertiesEncoded = {};
    this.modified = true;
    this.isEmpty = true;
};

TSDocument.prototype.registerReference = function (referenceName) {
    this.references.push(referenceName);
    this.modified = true;
    this.isEmpty = false;
};

TSDocument.prototype.hasProperty = function (propertyName) {
    return this.properties.hasOwnProperty(propertyName);
};

TSDocument.prototype.getProperty = function (propertyName, buildPropertyValue) {
    if (this.hasProperty(propertyName)) {
        return this.properties[propertyName];
    }
    else {
        var value = buildPropertyValue();
        if (!value) {
            return undefined;
        }
        this.setProperty(propertyName, value);
        return value;
    }
};

TSDocument.prototype.setProperty = function (propertyName, value) {
    var encoded = this._packProperty(propertyName, value);
    encoded = JSON.parse(JSON.stringify(encoded));

    this.properties[propertyName] = value;
    this._propertiesEncoded[propertyName] = encoded;
    this.modified = true;
    this.isEmpty = false;
};


//
// TSDocumentCache interface
//

function TSDocumentCache(path) {
    this._path = path;
    this._propertyPackers = {};
    this._cache = {};
}

TSDocumentCache.prototype._drop = function (documentName) {
    delete this._cache[documentName];
};

TSDocumentCache.prototype._validate = function (documentName) {
    var self = this;

    // Test if the document exists
    if (!this._cache.hasOwnProperty(documentName)) {
        return false;
    }

    // Get the document
    var doc = this._cache[documentName];

    // Test for changes
    var currentVersion = doc.handle.getVersion();
    if (currentVersion === false) {
        // Document source has become invalid
        this._drop(documentName);
        return false;
    }
    else if (currentVersion != doc.lastVersion) {
        // Document source changed
        doc.reset();
        doc.lastVersion = currentVersion;
        return false;
    }

    // Recursively test if any reference changed
    if (!doc.references.every(function (referenceName) {
        return self._validate(referenceName);
    })) {
        // At least one referenced document changed
        doc.reset();
        return false;
    }

    // The document and its dependencies are up-to-date
    return true;
};

TSDocumentCache.prototype.registerPropertyPacker = function (name, pack, unpack) {
    this._propertyPackers[name] = {pack: pack, unpack: unpack};
};

TSDocumentCache.prototype.loadFromDisk = function (buildDocumentHandle) {
    var self = this;

    // Collect all files ending in ".tscache"
    var files = fs.readdirSync(this._path).filter(function (name) {
        return path.extname(name) == TSDocument.fileExtension;
    });

    files.forEach(function (fileName) {
        // Read and decode each file
        var filePath = path.resolve(self._path, fileName);
        var diskDocument = JSON.parse(fs.readFileSync(filePath, {encoding: "utf8"}));

        // Construct handle
        var handle = buildDocumentHandle(diskDocument.name);

        // Construct internal representation of document
        var doc = new TSDocument(diskDocument.name, self._propertyPackers);
        doc.importDiskDocument(diskDocument);
        doc.handle = handle;

        // Invalidate if needed
        var currentVersion = handle.getVersion();
        if (currentVersion === false) {
            try { fs.unlinkSync(filePath); } catch (e) { }
            return;
        }
        else if (currentVersion != doc.lastVersion) {
            doc.reset();
            doc.lastVersion = currentVersion;
        }

        // Store document
        self._cache[doc.name] = doc;
    });
};

TSDocumentCache.prototype.writeToDisk = function () {
    var self = this;
    var obsoleteDocuments = [];

    for (var documentName in this._cache) {
        if (!this._cache.hasOwnProperty(documentName))
            continue;

        var doc = this._cache[documentName];
        var filePath = path.resolve(this._path, doc.nameOnDisk);

        if (doc.isEmpty) {
            // Remove from disk
            try { fs.unlinkSync(filePath); } catch (e) { }
            obsoleteDocuments.push(doc.name);
        }
        else if (doc.modified) {
            // Write updated document to disk
            var diskDocument = doc.toDiskDocument();
            var contents = JSON.stringify(diskDocument);
            fs.writeFileSync(filePath, contents, {encoding: "utf8"});
            doc.modified = false;
        }
    }

    obsoleteDocuments.forEach(function (documentName) {
        self._drop(documentName);
    });
};

TSDocumentCache.prototype.getDocument = function (documentName, buildDocumentHandle) {
    var self = this;
    var doc;

    this._validate(documentName);

    if (this._cache.hasOwnProperty(documentName)) {
        doc = this._cache[documentName];
    }
    else {
        // Fail if no handle factory was provided
        if (!buildDocumentHandle) {
            return false;
        }

        doc = new TSDocument(documentName, self._propertyPackers);
        doc.handle = buildDocumentHandle(documentName);
        this._cache[documentName] = doc;
    }

    return doc;
};

TSDocumentCache.prototype.getDocumentWithoutValidation = function (documentName) {
    if (this._cache.hasOwnProperty(documentName)) {
        return this._cache[documentName];
    }
    else {
        return undefined;
    }
};


//
// TSCompiler interface
//

function TSCompiler(context, documentCache) {
    this._context = context;
    this._documentCache = documentCache;
    this._postProcessors = [];
}

TSCompiler.prototype.addPostProcessor = function (postProcessor) {
    this._postProcessors.push(postProcessor);
};

TSCompiler.prototype._postProcess = function (fileName, source) {
    this._postProcessors.forEach(function (postProcessor) {
        source = postProcessor(fileName, source);
    });
    return source;
};

TSCompiler.prototype.run = function () {
    var self = this;
    var compilerOptions = self._context.options;
    var files = {}; // virtual filesystem, written to by the compiler host

    // Resolves a file name
    function getFilePath(fileName) {
        return path.resolve(self._context.rootPath, fileName);
    }

    // TypeScript compiler host interface: Provides filesystem and environment abstraction
    var compilerHost = {
        getSourceFile: function (fileName) {
            // Get or update cache entry
            var doc = self._documentCache.getDocument(fileName, self._context.createDocumentFileHandle);

            // Forward error
            if (!doc) {
                return undefined;
            }

            // Get AST using cached source text
            var haveUpdatedSourceFile = false;
            var sourceFile = doc.getProperty("ts-ast", function () {
                haveUpdatedSourceFile = true;
                var filePath = getFilePath(fileName);
                var source = fs.readFileSync(filePath, { encoding: compilerOptions.charset });
                return ts.createSourceFile(fileName, source, this.languageVersion);
            });

            // Register new references, if any
            if (haveUpdatedSourceFile) {
                sourceFile.referencedFiles.forEach(function (reference) {
                    // XXX TypeScript 1.5 changed reference's filename to fileName
                    var filePath = path.resolve(self._context.rootPath, fileName, "..", reference.filename);
                    var filePackagePath = path.relative(self._context.rootPath, filePath);
                    doc.registerReference(filePackagePath);
                });
            }

            return sourceFile;
        },
        writeFile: function (fileName, source) {
            // Post-process and store in virtual filesystem
            files[fileName] = self._postProcess(fileName, source);
        },
        getDefaultLibFilename: function () {
            // This is quite a mess. Microsoft wants us to use require.resolve for retrieving the path
            // to lib.d.ts, see https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API
            // However, Npm.resolve disappeared from Meteor some time ago.
            // As workaround, TypeScript's private system abstraction API is used. Sorry.
            var tsdir = path.resolve(path.dirname(ts.sys.getExecutingFilePath()));
            return path.join(tsdir, "lib.d.ts");
        },
        useCaseSensitiveFileNames: function () {
            return true;
        },
        getCanonicalFileName: function (fileName) {
            return fileName;
        },
        getCurrentDirectory: function () {
            return self._context.rootPath;
        },
        getNewLine: function () {
            return "\n";
        }
    };

    // Run TypeScript
    var program = ts.createProgram([self._context.inputFile], compilerOptions, compilerHost);

    // Test for fatal errors
    var errors = program.getDiagnostics();

    // Continue only if no fatal errors occurred
    if (!errors.length) {
        // Test for type errors
        var checker = program.getTypeChecker(true);
        errors = checker.getDiagnostics();
    }

    // Continue only if no type checking errors occurred
    if (!errors.length) {
        // Generate output files (including redundant/unused referenced files)
        // XXX TypeScript 1.5 changed the API and allows emitting single files. This removes overhead:
        // var ast = self._documentCache.getDocumentWithoutValidation(this._context.inputFile).getProperty("ts-ast");
        // program.emit(ast);
        checker.emitFiles();

        return { files: files, errors: [] };
    }
    else {
        return { files: [], errors: errors };
    }
};


//
// Meteor-specific helper utilities
//

function meteorPostProcess(compileStep, fileName, source) {
    // Only modify JavaScript output files
    if (fileName.slice(-3) != ".js")
        return source;

    // This function modifies the TypeScript compiler's output so that all modules
    // and classes declared in the top level scope are assigned to the package scope
    // provided by Meteor. I will probably go to hell for this.
    var beginModule = /^var (.+);$/;
    var beginClass = /^var (.+) = \(function \(\) {$/;
    return _.map(source.split("\n"), function (line) {
        var m;
        if (m = line.match(beginModule)) {
            if (compileStep.declaredExports.indexOf(m[1]) != -1) {
                // Exports have a package-scope var statement
                return "";
            }
            else {
                // Write to global scope
                return "if (typeof " + m[1] + " === \"undefined\") " + m[1] + " = {};";
            }
        }
        else if (m = line.match(beginClass)) {
            // Does the right thing in both cases
            return m[1] + " = (function () {";
        }
        else {
            // No change
            return line;
        }
    }).join("\n");
}

function meteorErrorFromCompilerError(compileStep, e) {
    if (e.file) {
        var pos = e.file.getLineAndCharacterFromPosition(e.start);
        return {
            message: e.messageText,
            sourcePath: e.file.filename,
            line: pos.line,
            column: pos.column
        };
    }
    else {
        return {
            message: e.messageText,
            sourcePath: compileStep.inputPath
        };
    }
}


//
// Cache persistence
//

var _typeScriptCacheList = {};
var _typeScriptCachePath = path.resolve(".meteor/local/typescript-cache");

function mkdirp(path) {
    try {
        fs.mkdirSync(path);
    }
    catch (e) {
        if (e.code != "EEXIST") {
            throw e;
        }
    }
}

function loadDocumentCache(compileStep, createDocumentFileHandle) {
    // Select a cache identifier which fulfills the following criteria:
    // - Is a valid directory name
    // - Unique per TypeScript AST generator branch
    // - Unique per package
    // This causes lib.d.ts to be compiled multiple times (once for each package and target), but avoids
    // common pitfalls such as the requirement to use absolute paths.
    var id = (compileStep.packageName ? ("package_" + sanitize(compileStep.packageName)) : "application")
        + "_" + sanitize(compileStep.arch);

    if (_typeScriptCacheList.hasOwnProperty(id)) {
        // Get cache
        return _typeScriptCacheList[id];
    }
    else {
        // Create cache
        var cachePath = path.join(_typeScriptCachePath, id);
        mkdirp(cachePath);
        var cache = new TSDocumentCache(cachePath);
        //cache.registerPropertyPacker("ts-ast", freezeDrySourceFile, hydrateSourceFile);
        //cache.loadFromDisk(createDocumentFileHandle);
        _typeScriptCacheList[id] = cache;
        return cache;
    }

    function sanitize(fileName) {
        return fileName.replace(/[^a-zA-Z0-9]/, "_");
    }

    function freezeDrySourceFile(sourceFile) {
        // Workaround for TypeScript 1.4: SourceFile is not serializable out-of-the-box.
        // Fortunately, reconstructing the missing pieces is trivial.
        // XXX TypeScript 1.5 explicitly supports serialization, thus making this workaround obsolete.
        //sourceFile.getSyntacticDiagnostics();
        return _.omit(sourceFile,
            "getLineAndCharacterFromPosition",
            "getPositionFromLineAndCharacter",
            "getLineStarts",
            "getSyntacticDiagnostics"
        );
    }

    function hydrateSourceFile(partialSourceFile) {
        // Instant Source Files! Just add water! These functions come directly from the
        // TypeScript 1.4 source code, and were slightly modified to work with preprocessed data.
        // XXX Remove with TypeScript 1.5
        var sourceFile = _.clone(partialSourceFile);
        var lineStarts;
        var syntacticDiagnostics;
        return _.extend(sourceFile, {
            getLineAndCharacterFromSourcePosition: function (position) {
                return ts.getLineAndCharacterOfPosition(sourceFile.getLineStarts(), position);
            },
            getPositionFromSourceLineAndCharacter: function (line, character) {
                return ts.getPositionFromLineAndCharacter(sourceFile.getLineStarts(), line, character);
            },
            getLineStarts: function () {
                return lineStarts || (lineStarts = ts.computeLineStarts(sourceFile.text));
            },
            getSyntacticDiagnostics: function () {
                if (syntacticDiagnostics === undefined) {
                    if (sourceFile.parseDiagnostics.length > 0) {
                        syntacticDiagnostics = sourceFile.referenceDiagnostics.concat(sourceFile.parseDiagnostics);
                    }
                    else {
                        syntacticDiagnostics = sourceFile.referenceDiagnostics.concat(sourceFile.grammarDiagnostics);
                    }
                }
                return syntacticDiagnostics;
            }
        });
    }
}

function initDocumentCache() {
    // Ensure that the top-level cache directory exists
    mkdirp(_typeScriptCachePath);
}


//
// Meteor plugin registration
//

function compileTypeScriptImpl(compileStep) {
    // Absolute path to the current package or application root.
    // This is a tiny bit ugly.
    var packageBasePath = compileStep.fullInputPath.slice(0, -1 * compileStep.inputPath.length);

    // Retrieve a cache instance
    var documentCache = loadDocumentCache(compileStep, createDocumentFileHandle);
    var doc = documentCache.getDocument(compileStep.inputPath);
    var js;

    // Test if results have been cached for the current compile step
    if (doc && doc.hasProperty("meteor-js")) {
        // Fast lane! Use the cached result
        js = doc.getProperty("meteor-js");
    }
    else {
        // Slow route: Compile the file, have the compiler add its references to the
        // AST cache, and add the Meteor result to the JS cache.
        console.log("XXXDBG recompiling: " + compileStep.inputPath);

        // Meteor-compatible set of compiler options
        var compilerMapBasePath = path.dirname(compileStep.pathForSourceMap);
        var compilerContext = {
            createDocumentFileHandle: createDocumentFileHandle,
            rootPath: packageBasePath,
            inputFile: compileStep.inputPath,
            options: {
                charset: "utf8",
                mapRoot: compilerMapBasePath,
                removeComments: true,
                sourceMap: true,
                sourceRoot: compilerMapBasePath,
                target: (compileStep.arch == "web.browser") ? "ES3" : "ES5"
            }
        };

        // Construct a compiler instance
        var compiler = new TSCompiler(compilerContext, documentCache);
        compiler.addPostProcessor(function (fileName, source) {
            return meteorPostProcess(compileStep, fileName, source);
        });

        // Compile files
        var compilerResult = compiler.run();

        // Test for errors
        if (compilerResult.errors.length == 0) {
            // Expected output file name
            var jsPath = compileStep.inputPath.slice(0, -3) + ".js";

            // Build JavaScript file information for Meteor
            js = {
                path: jsPath,
                data: compilerResult.files[jsPath],
                sourcePath: compileStep.inputPath,
                sourceMap: compilerResult.files[jsPath + ".map"]
            };

            // Sanity check
            if (typeof js.data !== "string" || typeof js.sourceMap !== "string") {
                throw new Error("Something is broken. Empty data or source map. (This is probably not your fault.)");
            }

            // Register result with document cache
            var newdoc = documentCache.getDocumentWithoutValidation(compileStep.inputPath);
            if (newdoc) {
                newdoc.setProperty("meteor-js", js);
            }
        }
        else {
            // Log all errors
            compilerResult.errors.forEach(function (error) {
                compileStep.error(meteorErrorFromCompilerError(compileStep, error));
            });
        }
    }

    //documentCache.writeToDisk();

    if (js) {
        // Register compiled JavaScript file with Meteor
        compileStep.addJavaScript(js);

        // XXX Register result.watchSet entries with Meteor. There is no API for this yet.
        // The Less and Stylus plugin suffer from the same issue: Changed references do not
        // cause the build process to re-run.
        // Watch these plugins for changes and update this plugin when ready.
    }

    function createDocumentFileHandle(fileName) {
        var filePath = path.resolve(packageBasePath, fileName);
        return {
            // Returns an integer that, when changed, indicates a change in the file content
            // Returns false for an invalid document
            getVersion: function () {
                try {
                    return fs.statSync(filePath).mtime.getTime();
                }
                catch (e) {
                    return false;
                }
            }
        };
    }
}

function compileTypeScriptDef(compileStep) {
    // Do nothing. TypeScript definition files produce no code.
    // Error checking happens when the definition file is referenced.
}

Plugin.registerSourceHandler("ts", compileTypeScriptImpl);
Plugin.registerSourceHandler("d.ts", compileTypeScriptDef);
