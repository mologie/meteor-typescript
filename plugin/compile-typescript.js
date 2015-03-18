// TypeScript integration for Meteor
// Copyright 2015 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

var ts = Npm.require("typescript");
var path = Npm.require("path");
var fs = Npm.require("fs");

function TypeScriptCompiler(context) {
    this._context = context;
    this._preProcessors = [];
    this._postProcessors = [];
}

TypeScriptCompiler.prototype.addPreProcessor = function (preProcessor) {
    this._preProcessors.push(preProcessor);
};

TypeScriptCompiler.prototype.addPostProcessor = function (postProcessor) {
    this._postProcessors.push(postProcessor);
};

TypeScriptCompiler.prototype._preProcess = function (fileName, source) {
    this._preProcessors.forEach(function (preProcessor) {
        source = preProcessor(fileName, source);
    });
    return source;
};

TypeScriptCompiler.prototype._postProcess = function (fileName, source) {
    this._postProcessors.forEach(function (postProcessor) {
        source = postProcessor(fileName, source);
    });
    return source;
};

TypeScriptCompiler.prototype.run = function () {
    var files = {}; // virtual filesystem, written to by the compiler host
    var references = []; // absolute paths of referenced files
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

    // Synchronously reads a file as per request of the compiler host
    function readFile(filePath) {
        filePath = path.resolve(self._context.rootPath, filePath);
        return fs.readFileSync(filePath, { encoding: compilerOptions.charset });
    }

    // Tracks references/dependencies of processed source files
    function recordFileReferences(sourceFile) {
        sourceFile.referencedFiles.forEach(function (referencedFile) {
            var basePath = path.dirname(path.resolve(self._context.rootPath, sourceFile.filename));
            var filePath = path.resolve(basePath, referencedFile.filename);
            references.push(filePath);
        });
    }

    // TypeScript compiler host interface: Provides file system and environment abstraction
    var compilerHost = {
        getSourceFile: function (fileName, languageVersion) {
            try {
                var source = readFile(fileName);
                source = self._preProcess(fileName, source);
                var sourceFile = ts.createSourceFile(fileName, source, languageVersion);
                recordFileReferences(sourceFile);
                return sourceFile;
            }
            catch (e) {
                // We surely could complain here, but TypeScript already does its own error handling
                // if this method returns no value.
                // XXX This will confuse the user if we instead have no permission to read the file.
                return undefined;
            }
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

    // Run TypeScript
    var program = ts.createProgram(this._context.inputFiles, compilerOptions, compilerHost);

    // Test for fatal errors
    var errors = program.getDiagnostics();

    // Continue only if no fatal errors occurred
    if (!errors.length) {
        // Test for type errors
        var checker = program.getTypeChecker(true);
        errors = checker.getDiagnostics();

        // Generate output regardless of type errors
        checker.emitFiles();
    }

    // Unclutter dependency list
    references = _.unique(references);

    return { files: files, references: references, errors: errors };
};

function postProcessForMeteor(fileName, source) {
    // This function modifies the TypeScript compiler's output so that all modules
    // and classes declared in the top level scope are assigned to the package scope
    // provided by Meteor. I will probably go to hell for this.
    var beginModule = /^var .+;$/;
    var beginClass = /^var (.+) = \(function \(\) {$/;
    return _.map(source.split("\n"), function (line) {
        var m;
        if (m = line.match(beginModule)) {
            return "";
        }
        else if (m = line.match(beginClass)) {
            return m[1] + " = (function () {";
        }
        else {
            return line;
        }
    }).join("\n");
}

function meteorErrorFromCompilerError(compileStep, e) {
    if (e.file) {
        var pos = e.file.getLineAndCharacterFromPosition(e.start);
        var packageBasePath = compileStep.fullInputPath.slice(0, -1 * compileStep.inputPath.length);
        var absPath = path.resolve(path.dirname(compileStep.fullInputPath), e.file.filename);
        var packageFilePath = path.relative(packageBasePath, absPath);
        return {
            message: e.messageText,
            sourcePath: packageFilePath,
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

TypeScriptCompiler.createFromCompileStep = function (compileStep) {
    var compiler = new TypeScriptCompiler({
        rootPath: path.dirname(compileStep.fullInputPath),
        mapBasePath: path.dirname(compileStep.pathForSourceMap),
        inputFiles: [path.basename(compileStep.fullInputPath)],
        target: (compileStep.arch == "web.browser") ? "ES3" : "ES5"
    });
    compiler.addPostProcessor(postProcessForMeteor);
    return compiler;
};

TypeScriptCompiler.registerResultWithBuilder = function (compileStep, result) {
    if (result.errors.length == 0) {
        // Build JavaScript file information for Meteor
        var jsName = path.basename(compileStep.inputPath, ".ts") + ".js";
        var jsNameForMeteor = path.join(path.dirname(compileStep.inputPath), jsName);
        var js = {
            path: jsNameForMeteor,
            data: result.files[jsName],
            sourcePath: compileStep.inputPath,
            sourceMap: result.files[jsName + ".map"]
        };

        // Sanity check
        if (typeof js.data !== "string" || typeof js.sourceMap !== "string") {
            throw new Error("Something is broken. Empty data or source map. (This is probably not your fault.)");
        }

        // Register compiled JavaScript file with Meteor
        compileStep.addJavaScript(js);

        // XXX Register references with Meteor. There is no API for this yet.
        // for each reference, compileStep.registerDependency(reference)
    }
    else {
        // Log all errors and do not register the results with Meteor
        result.errors.forEach(function (error) {
            compileStep.error(meteorErrorFromCompilerError(compileStep, error));
        });
    }
};

function compileTypeScriptImpl(compileStep) {
    var result = TypeScriptCompiler.createFromCompileStep(compileStep).run();
    TypeScriptCompiler.registerResultWithBuilder(compileStep, result);
}

function compileTypeScriptDef(compileStep) {
    // Do nothing. TypeScript definition files produce no code.
    // Error checking happens when the definition file is referenced.
}

Plugin.registerSourceHandler("ts", compileTypeScriptImpl);
Plugin.registerSourceHandler("d.ts", compileTypeScriptDef);
