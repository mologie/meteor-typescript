// TypeScript integration for Meteor
// Copyright 2015 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

var ts,
    path = Npm.require("path"),
    fs = Npm.require("fs");


//
// TSDocument interface
//

function TSDocument(name, handle) {
    this.name = name;
    this.handle = handle;
    this.reset();
}

TSDocument.prototype.reset = function () {
    this.references = {};
    this.properties = {};
    this.lastVersion = this.handle.getVersion();
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
    this.properties[propertyName] = value;
};


//
// TSDocumentCache interface
//

function TSDocumentCache() {
    this._cache = {};
}

TSDocumentCache.prototype._drop = function (documentName) {
    delete this._cache[documentName];
};

TSDocumentCache.prototype._validate = function (documentName, _validatedFiles) {
    var self = this;
    var validatedFiles = _validatedFiles || {};

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
        return false;
    }

    // Recursively test if any references changed
    if (!Object.keys(doc.references).every(validateReference)) {
        // At least one referenced document changed
        doc.reset();
        return false;
    }

    // The document and its dependencies are up-to-date
    return true;

    function validateReference(referenceName) {
        // Break reference cycles
        if (validatedFiles.hasOwnProperty(referenceName))
            return true;
        validatedFiles[referenceName] = true;

        // Validate file
        self._validate(referenceName, validatedFiles);

        // Validate file version
        var ref = self.getDocument(referenceName, null, false);
        if (ref) {
            return ref.lastVersion == doc.references[referenceName];
        }
        else {
            return false;
        }
    }
};

TSDocumentCache.prototype.getDocument = function (documentName, buildDocumentHandle, validate) {
    var self = this;
    var doc;

    if (validate === undefined) {
        validate = true;
    }

    if (validate) {
        this._validate(documentName);
    }

    if (this._cache.hasOwnProperty(documentName)) {
        doc = this._cache[documentName];
    }
    else {
        // Fail if no handle factory was provided
        if (!buildDocumentHandle)
            return undefined;

        // Request handle
        var handle = buildDocumentHandle(documentName);
        if (!handle)
            return undefined;

        // Create document
        doc = new TSDocument(documentName, handle);
        if (doc.lastVersion === false)
            return undefined;

        // Store document
        this._cache[documentName] = doc;
    }

    return doc;
};

TSDocumentCache.prototype.cleanup = function () {
    var self = this;
    Object.keys(this._cache).forEach(function (documentName) {
        self._validate(documentName);
    });
};

TSDocumentCache.prototype.isEmpty = function () {
    return Object.keys(this._cache).length == 0;
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

    // TypeScript compiler host interface: Provides filesystem and environment abstraction
    var compilerHost = {
        getSourceFile: function (fileName) {
            // This is where the magic happens
            return loadSourceFileFromCache(fileName);
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
            return ts.sys.useCaseSensitiveFileNames;
        },
        getCanonicalFileName: function (fileName) {
            return ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
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

    function loadSourceFileFromCache(fileName) {
        var doc = loadFromCache(fileName);
        if (!doc)
            return undefined;
        return doc.getProperty("ts-ast");
    }

    function loadFromCache(fileName, _referenceList) {
        // Get or update cache entry
        var doc = self._documentCache.getDocument(fileName, createDocumentFileHandle);
        if (!doc)
            return undefined;

        // Get cached syntax tree
        var haveUpdatedSourceFile = false;
        var sourceFile = doc.getProperty("ts-ast", function () {
            haveUpdatedSourceFile = true;
            var filePath = getFilePath(fileName);
            var source = fs.readFileSync(filePath, { encoding: compilerOptions.charset });
            return ts.createSourceFile(fileName, source, this.languageVersion);
        });

        // Update references recursively if needed
        if (haveUpdatedSourceFile) {
            var references = {};

            sourceFile.referencedFiles.forEach(function (reference) {
                var referenceAbsPath = path.resolve(self._context.rootPath, fileName, "..", reference.filename);
                var referenceName = path.relative(self._context.rootPath, referenceAbsPath);

                // Parse referenced file recursively and store version
                var ref = loadFromCache(referenceName, references);
                if (ref) {
                    references[referenceName] = ref.lastVersion;
                }
                else {
                    // The referenced file probably does not exist. Always rebuild.
                    references[referenceName] = false;
                    debugLog("file", fileName, "contains reference invalid file", referenceName, "(as " + reference.filename + ")");
                }
            });

            // Removing implicit references to self
            delete references[fileName];

            // Register references with document cache
            doc.references = references;

            // Add to parent's list
            if (_referenceList)
                _.extend(_referenceList, references);
        }

        return doc;
    }

    function createDocumentFileHandle(fileName) {
        var filePath = getFilePath(fileName);
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

    function getFilePath(fileName) {
        return path.resolve(self._context.rootPath, fileName);
    }
};


//
// Meteor-specific helper utilities
//

function debugLog() {
    if (!process.env.hasOwnProperty("TYPESCRIPT_DEBUG"))
        return;
    var prefix = ["[TypeScript Debug]"];
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(null, prefix.concat(args));
}

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

var _typeScriptCacheVersion = 1;
var _typeScriptCacheList;

(function initDocumentCache() {
    // Meteor (rightfully, yet annoyingly) resets everything it can get its hands on when rebuilding.
    // This plugin however must persist data across rebuilds in order to provide efficient output caching.
    // As workaround, this plugin modifies Node's global process object to do its bidding. What a mess.

    var shouldReset =
        (typeof process.__typescript_cache === "undefined") ||
        (process.__typescript_cache.version !== _typeScriptCacheVersion) ||
        (process.env.hasOwnProperty("TYPESCRIPT_DISABLE_CACHE"));

    if (shouldReset) {
        process.__typescript_cache = {
            version: _typeScriptCacheVersion,
            caches: {},
            ts: Npm.require("typescript")
        };
    }

    _typeScriptCacheList = process.__typescript_cache.caches;
    ts = process.__typescript_cache.ts;

    if (shouldReset) {
        // Nothing to do, the cache is empty
        return;
    }

    // In order to aid debugging across rebuilds and make the garbage collector happy, replace the
    // prototype of all existing cache structures to point to this object's new, potentially modified prototype.
    // The only information that remains from the previous run are document handles, which should be fine.
    Object.keys(_typeScriptCacheList).forEach(function (cacheId) {
        var documentCache = _typeScriptCacheList[cacheId];

        // Update TSDocumentCache objects
        documentCache.__proto__ = TSDocumentCache.prototype;

        // Update TSDocument objects
        Object.keys(documentCache._cache).forEach(function (documentId) {
            documentCache._cache[documentId].__proto__ = TSDocument.prototype;
        });
    });

    // Finally, remove any invalid documents
    performCacheMaintenance();
})();

function loadDocumentCache(compileStep) {
    // Create a separate cache per source package and target architecture.
    // This causes lib.d.ts to be compiled multiple redundantly (once for each package), but drastically
    // simplifies this package's design by limiting dependency tracking to packages.
    var id = (compileStep.packageName ? ("package_" + sanitize(compileStep.packageName)) : "application")
        + "_" + sanitize(compileStep.arch);

    if (_typeScriptCacheList.hasOwnProperty(id)) {
        // Get cache
        return _typeScriptCacheList[id];
    }
    else {
        // Create cache
        var cache = new TSDocumentCache();
        _typeScriptCacheList[id] = cache;
        return cache;
    }

    function sanitize(fileName) {
        return fileName.replace(/[^a-zA-Z0-9]/, "_");
    }
}

function performCacheMaintenance() {
    for (var cacheId in _typeScriptCacheList) {
        if (!_typeScriptCacheList.hasOwnProperty(cacheId))
            continue;

        var cache = _typeScriptCacheList[cacheId];

        // Revalidate all cached documents
        cache.cleanup();

        // Remove the cache if empty
        if (cache.isEmpty()) {
            delete _typeScriptCacheList[cacheId];
        }
    }
}


//
// Meteor plugin registration
//

function compileTypeScriptImpl(compileStep) {
    var prefix = makeDebugPrefix();

    // Absolute path to the current package or application root.
    // This is a tiny bit ugly.
    var packageBasePath = compileStep.fullInputPath.slice(0, -1 * compileStep.inputPath.length);

    // Retrieve a cache instance
    var documentCache = loadDocumentCache(compileStep);
    var doc = documentCache.getDocument(compileStep.inputPath);
    var js;

    // Test if results have been cached for the current compile step
    if (doc && doc.hasProperty("meteor-js")) {
        // Fast lane! Use the cached result
        debugLog(prefix, "using cached result");
        js = doc.getProperty("meteor-js");
    }
    else {
        // Slow route: Compile the file, have the compiler add its references to the
        // AST cache, and add the Meteor result to the JS cache.
        debugLog(prefix, "rebuilding");

        // Meteor-compatible set of compiler options
        var compilerMapBasePath = path.dirname(compileStep.pathForSourceMap);
        var compilerContext = {
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
            // Output file name for Meteor
            var jsPath = compileStep.inputPath.slice(0, -3) + ".js";

            // Output file name for TypeScript
            var compilerOutputPath = jsPath.split(path.sep).join("/");

            // Build JavaScript file information for Meteor
            js = {
                path: jsPath,
                data: compilerResult.files[compilerOutputPath],
                sourcePath: compileStep.inputPath,
                sourceMap: compilerResult.files[compilerOutputPath + ".map"]
            };

            // Sanity check
            if (typeof js.data !== "string" || typeof js.sourceMap !== "string") {
                throw new Error("Something is broken. Empty data or source map. (This is probably not your fault.)");
            }

            // Register result with document cache
            var newdoc = documentCache.getDocument(compileStep.inputPath, null, false);
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

    if (js) {
        // Register compiled JavaScript file with Meteor
        compileStep.addJavaScript(js);
    }

    function makeDebugPrefix() {
        var pkgname = compileStep.packageName ? compileStep.packageName : "application";
        return pkgname + " for " + compileStep.arch + ", file " + compileStep.inputPath + ":";
    }
}

function compileTypeScriptDef(compileStep) {
    // Do nothing. TypeScript definition files produce no code.
    // Error checking happens when the definition file is referenced.
}

Plugin.registerSourceHandler("ts", compileTypeScriptImpl);
Plugin.registerSourceHandler("d.ts", compileTypeScriptDef);
