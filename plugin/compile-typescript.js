// TypeScript integration for Meteor
// Copyright 2015 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

var ts = Npm.require("typescript");
var path = Npm.require("path");
var fs = Npm.require("fs");
var crypto = Npm.require("crypto");


//
// Global cache list
//

var _typeScriptCacheList = {};

function typeScriptCacheForContext(context) {
    // Build shared context ID
    var md5 = crypto.createHash("md5");
    md5.update(context.rootPath);
    md5.update("_");
    md5.update(context.mapBasePath);
    md5.update("_");
    md5.update(context.target);

    var id = md5.digest("hex");

    if (_typeScriptCacheList.hasOwnProperty(id)) {
        // Get cache
        return _typeScriptCacheList[id];
    }
    else {
        // Create cache
        var cache = new TypeScriptCache(context.rootPath, context.target);
        _typeScriptCacheList[id] = cache;
        return cache;
    }
}


//
// TypeScriptCache interface
//

function TypeScriptCache(rootPath, languageVersion) {
    this.rootPath = rootPath;
    this.languageVersion = languageVersion;
    this._cache = {};
}

TypeScriptCache.prototype.getEntry = function (fileName) {
    return this._cache[fileName];
};

TypeScriptCache.prototype.createEntry = function (fileName, fileHandle) {
    var self = this;

    // Compile source file
    var sourceFile = ts.createSourceFile(fileName, fileHandle.source, this.languageVersion);

    // Gather references
    var references = _.map(sourceFile.referencedFiles, function (reference) {
        var refFilePath = path.resolve(self.rootPath, fileName, "..", reference.filename);
        return path.relative(self.rootPath, refFilePath);
    });

    // Create cache entry
    var cacheEntry = {
        sourceFile: sourceFile,
        references: references,
        stat: fileHandle.stat,
        lastChanged: fileHandle.stat().mtime
    };
    this._cache[fileName] = cacheEntry;

    return cacheEntry;
};

TypeScriptCache.prototype.drop = function (fileName) {
    delete this._cache[fileName];
};

TypeScriptCache.prototype.validate = function (fileName) {
    var self = this;

    // Test if an entry exists
    if (!this._cache.hasOwnProperty(fileName)) {
        return false;
    }

    // Get the entry
    var entry = this._cache[fileName];

    // Test if the file timestamp changed
    try {
        // Compare timestamp
        if (entry.stat().mtime.getTime() != entry.lastChanged.getTime()) {
            return false;
        }
    }
    catch (e) {
        // Assume that file was deleted
        return false;
    }

    // Recursively test if any reference changed
    if (!entry.references.every(function (reference) {
        return self.validate(reference);
    })) {
        return false;
    }

    // The file and its references are up-to-date
    return true;
};

TypeScriptCache.prototype.getValidatedEntry = function (fileName, getSourceHandle) {
    if (this.validate(fileName)) {
        return this.getEntry(fileName).sourceFile;
    }
    else {
        this.drop(fileName);
        var fileHandle = getSourceHandle();
        return fileHandle ? this.createEntry(fileName, fileHandle).sourceFile : undefined;
    }
};

TypeScriptCache.prototype.compileWatchSet = function (fileName) {
    var self = this;
    var watchSet = [];
    function extendWatchSet(entry) {
        if (!entry || !entry.hasOwnProperty("references"))
            return;
        watchSet = _.union(watchSet, entry.references);
        entry.references.forEach(function (referenceName) {
            var nextEntry = self.getEntry(referenceName);
            extendWatchSet(nextEntry);
        });
    }
    extendWatchSet(this.getEntry(fileName));
    return watchSet;
};


//
// TypeScriptCompiler interface
//
// Performs compilation steps of a given context (root path, map base path, input files, target language)
// Makes calls to the cache manager for optimization purposes.
//

function TypeScriptCompiler(context) {
    this._context = context;
    this._cache = typeScriptCacheForContext(context);
    this._postProcessors = [];
}

TypeScriptCompiler.prototype.addPostProcessor = function (postProcessor) {
    this._postProcessors.push(postProcessor);
};

TypeScriptCompiler.prototype._postProcess = function (fileName, source) {
    this._postProcessors.forEach(function (postProcessor) {
        source = postProcessor(fileName, source);
    });
    return source;
};

TypeScriptCompiler.prototype.run = function () {
    var files = {}; // virtual filesystem, written to by the compiler host
    var self = this;

    // Meteor-compatible set of compiler options
    var compilerOptions = {
        charset: "utf8",
        mapRoot: this._context.mapBasePath,
        removeComments: true,
        sourceMap: true,
        sourceRoot: this._context.mapBasePath,
        target: this._context.target
    };

    // Builds a file handle for the cache manager
    function makeFileHandle(fileName) {
        var filePath = path.resolve(self._context.rootPath, fileName);
        var source = fs.readFileSync(filePath, { encoding: compilerOptions.charset });
        return {
            source: source,
            stat: function () { return fs.statSync(filePath); }
        };
    }

    // TypeScript compiler host interface: Provides file system and environment abstraction
    var compilerHost = {
        getSourceFile: function (fileName) {
            // Get validated cache entry
            return self._cache.getValidatedEntry(fileName, function () {
                try {
                    return makeFileHandle(fileName);
                }
                catch (e) {
                    return undefined;
                }
            });
        },
        writeFile: function (fileName, source) {
            // Post-process and store contents in virtual filesystem
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

    // Fast lane: Skip type checking if file and its dependencies are unchanged
    if (this._cache.validate(this._context.inputFile)) {
        var cacheEntry = this._cache.getEntry(this._context.inputFile);
        if (cacheEntry.hasOwnProperty("results")) {
            return cacheEntry.results;
        }
    }

    // Run TypeScript
    var program = ts.createProgram([this._context.inputFile], compilerOptions, compilerHost);

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
        // Generate output files
        checker.emitFiles();

        // Generate watch set
        var watchSet = this._cache.compileWatchSet(this._context.inputFile);

        // Build and cache result set
        var results = { files: files, watchSet: watchSet, errors: [] };
        this._cache.getEntry(this._context.inputFile).results = results;

        return results;
    }
    else {
        return { files: [], watchSet: [], errors: errors };
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

function meteorTypeScriptCompiler(compileStep) {
    var packageBasePath = compileStep.fullInputPath.slice(0, -1 * compileStep.inputPath.length);
    var compiler = new TypeScriptCompiler({
        rootPath: packageBasePath,
        mapBasePath: path.dirname(compileStep.pathForSourceMap), // XXX
        inputFile: compileStep.inputPath,
        target: (compileStep.arch == "web.browser") ? "ES3" : "ES5"
    });
    compiler.addPostProcessor(function (fileName, source) {
        return meteorPostProcess(compileStep, fileName, source);
    });
    return compiler;
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

function registerResultWithBuilder(compileStep, result) {
    if (result.errors.length == 0) {
        // Build JavaScript file information for Meteor
        var jsPath = compileStep.inputPath.slice(0, -3) + ".js";
        var js = {
            path: jsPath,
            data: result.files[jsPath],
            sourcePath: compileStep.inputPath,
            sourceMap: result.files[jsPath + ".map"]
        };

        // Sanity check
        if (typeof js.data !== "string" || typeof js.sourceMap !== "string") {
            throw new Error("Something is broken. Empty data or source map. (This is probably not your fault.)");
        }

        // Register compiled JavaScript file with Meteor
        compileStep.addJavaScript(js);

        // XXX Register result.watchSet entries with Meteor. There is no API for this yet.
    }
    else {
        // Log all errors and do not register the results with Meteor
        result.errors.forEach(function (error) {
            compileStep.error(meteorErrorFromCompilerError(compileStep, error));
        });
    }
}


//
// Meteor plugin registration
//

function compileTypeScriptImpl(compileStep) {
    var result = meteorTypeScriptCompiler(compileStep).run();
    registerResultWithBuilder(compileStep, result);
}

function compileTypeScriptDef(compileStep) {
    // Do nothing. TypeScript definition files produce no code.
    // Error checking happens when the definition file is referenced.
}

Plugin.registerSourceHandler("ts", compileTypeScriptImpl);
Plugin.registerSourceHandler("d.ts", compileTypeScriptDef);
