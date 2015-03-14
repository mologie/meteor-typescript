// TypeScript integration for Meteor
// Copyright 2015 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

// Known issues:
// - There is no dependency tracking for reference tracking due to limitations of Meteor's compileStep API.
//   This affects other language plugins such as less and stylus too.
//   Workaround: Restart Meteor if declaration files changed and affect your project files.
// - Sloppy error handling for invalid references (will always display "file not found").

var ts = Npm.require("typescript");
var path = Npm.require("path");
var fs = Npm.require("fs");

function performStep(compileStep) {
    var files = {}; // virtual filesystem, written to by the compiler host
    var references = []; // references recorded as files are processed
    var rootPath = path.dirname(compileStep.fullInputPath); // used for resolving relative paths
    var relativeBasePath = path.dirname(compileStep.pathForSourceMap); // just what Meteor wants to hear

    // Meteor-compatible set of compiler options
    var compilerOptions = {
        charset: "utf8",
        mapRoot: relativeBasePath,
        removeComments: true,
        sourceMap: true,
        sourceRoot: relativeBasePath,
        target: (compileStep.arch == "browser") ? "ES3" : "ES5"
    };

    // Synchronously reads a file as per request of the compiler host
    function readFile(filePath) {
        filePath = path.resolve(rootPath, filePath);
        return fs.readFileSync(filePath, { encoding: compilerOptions.charset });
    }

    // Tracks references/dependencies of processed source files
    function recordFileReferences(sourceFile) {
        sourceFile.referencedFiles.forEach(function (referencedFile) {
            var basePath = path.dirname(path.resolve(rootPath, sourceFile.filename));
            var filePath = path.resolve(basePath, referencedFile.filename);
            references.push(filePath);
        });
    }

    // TypeScript compiler host interface: Provides file system and environment abstraction
    var compilerHost = {
        getSourceFile: function (fileName, languageVersion) {
            var source;
            if (fileName == compileStep.inputPath) {
                source = compileStep.read().toString(compilerOptions.charset);
            }
            else {
                try {
                    source = readFile(fileName);
                }
                catch (e) {
                    // We surely could complain here, but TypeScript already does its own error handling
                    // if this method returns no value.
                    // XXX This will confuse the user if we instead have no permission to read the file.
                    return undefined;
                }
            }
            var sourceFile = ts.createSourceFile(fileName, source, languageVersion);
            recordFileReferences(sourceFile);
            return sourceFile;
        },
        writeFile: function (name, text) {
            // Store contents in virtual filesystem dictionary
            files[name] = text;
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
            return rootPath;
        },
        getNewLine: function () {
            return "\n";
        }
    };

    // Run TypeScript
    var program = ts.createProgram([compileStep.inputPath], compilerOptions, compilerHost);

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
}

function meteorErrorFromCompilerError(compileStep, e) {
    if (!e.file) {
        return {
            message: e.messageText,
            sourcePath: compileStep.inputPath
        };
    }
    var pos = e.file.getLineAndCharacterFromPosition(e.start);
    return {
        message: e.messageText,
        sourcePath: e.file.filename,
        line: pos.line,
        column: pos.column
    };
}

function compileTypeScriptImpl(compileStep) {
    // Compile TypeScript file
    var result = performStep(compileStep);

    if (result.errors.length == 0) {
        // Build JavaScript file information for Meteor
        var jsName = compileStep.inputPath.slice(0, -3) + ".js";
        var js = {
            path: jsName,
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
}

function compileTypeScriptDef(compileStep) {
    // Do nothing. TypeScript definition files produce no code.
    // Error checking happens when the definition file is referenced.
}

Plugin.registerSourceHandler("ts", compileTypeScriptImpl);
Plugin.registerSourceHandler("d.ts", compileTypeScriptDef);
