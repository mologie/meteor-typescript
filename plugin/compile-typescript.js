// TypeScript for Meteor
// Copyright 2015-2016 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

// TODO:
// tsconfig.json support
// select ES3 for browser and ES5 for node 0.10
// allow defining application-wide typings
// implement serializing/deserializing document cache
// write/test export support
// write tests
// update readme
// update changelog

var fs = Plugin.fs;
var path = Plugin.path;
var ts = Npm.require("typescript");

class TSCompiler {
    constructor() {
        // Default TypeScript compiler options if no tsconfig.json file is found
        // From https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API
        this.defaultOptions = {
            noEmitOnError: true,
            noImplicitAny: true,
            module: ts.ModuleKind.CommonJS
        };

        // Shared cache for the lifetime of this object
        this.archCache = {};
        this.documentRegistry = ts.createDocumentRegistry();
    }

    setDiskCacheDirectory(diskCache) {
        // Meteor calls setDiskCacheDirectory immediately after creating the TSCompiler class.
        // Some Meteor plugins have the same check, so this will probably last.
        if (this.diskCache)
            throw Error("setDiskCacheDirectory called twice");
        this.diskCache = diskCache;
        this.loadDocumentCache();
    }

    loadDocumentCache() {
        // TODO
    }

    saveDocumentCache() {
        // TODO
    }

    processFilesForTarget(inputFiles) {
        // Process each architecture
        let filesPerArch = _.groupBy(inputFiles, (file) => file.getArch());
        for (let arch of Object.keys(filesPerArch)) {
            if (!(arch in this.archCache))
                this.archCache[arch] = {};
            this.processFilesForArch(arch, this.archCache[arch], filesPerArch[arch]);
        }

        // Sync cache to disk
        this.saveDocumentCache();
    }

    processFilesForArch(arch, archCache, inputFiles) {
        // Process files per package
        // Meteor performs garbage collection automatically by destryoing TSCompiler if the list
        // of embedded packages changes.
        let filesPerPackage = _.groupBy(inputFiles, (file) => file.getPackageName() || "");
        for (let packageName of Object.keys(filesPerPackage)) {
            if (!(packageName in archCache))
                archCache[packageName] = {};
            this.processFilesForPackage(packageName, archCache[packageName], arch,
                filesPerPackage[packageName]);
        }
    }

    processFilesForPackage(packageName, packageCache, packageArch, inputFiles) {
        // Heuristics for better embedded package support
        // By rebasing all paths into the package's real directory, referencing files outside of
        // the package becomes possible.
        // - This behavior is required to be compatible with <1.0.0 versions of this plugin.
        // - Name conflicts between package files and application files are avoided.
        let buildingEmbeddedPackage = fs.existsSync("packages/" + packageName);
        var filePrefix = "";
        if (buildingEmbeddedPackage)
            filePrefix = "packages/" + packageName + "/";

        // Collect files which need compiling
        var rootFiles = [];
        inputFiles.forEach((file) => {
            if (!TSCompiler.isDefinitionFile(file) && !TSCompiler.isConfigFile(file))
                rootFiles.push(filePrefix + file.getPathInPackage());
        });

        // Create file index
        var filesByPath = _.indexBy(inputFiles, (file) => filePrefix + file.getPathInPackage());

        // Process configuration
        // Syntax change test taken from TypeScript's src/services/services.ts
        var oldSettings = packageCache.program && packageCache.program.getCompilerOptions();
        var newSettings = this.defaultOptions; // TODO use tsconfig.json
        var newSettingsChangeSyntax = oldSettings &&
            (oldSettings.target !== newSettings.target ||
             oldSettings.module !== newSettings.module ||
             oldSettings.noResolve !== newSettings.noResolve ||
             oldSettings.jsx !== newSettings.jsx);

        // Compiler host specific to this package and architecture
        var compilerOutput = {};
        var compilerHost = {
            getSourceFile: (fileName) => {
                console.log("getSourceFilePath " + fileName);
                let script = findScript(fileName);
                if (!script) {
                    console.log("bailing out");
                    return undefined;
                }

                // Attempt to get or update an existing cache entry
                if (!newSettingsChangeSyntax) {
                    let oldProgram = packageCache.program;
                    let oldSourceFile = oldProgram && oldProgram.getSourceFile(fileName);
                    if (oldSourceFile) {
                        return this.documentRegistry.updateDocument(fileName, newSettings,
                            script.snapshot, script.version);
                    }
                }

                // Create a new cache entry
                return this.documentRegistry.acquireDocument(fileName, newSettings,
                    script.snapshot, script.version);
            },

            getCanonicalFileName: (fileName) => {
                return fileName;
            },

            useCaseSensitiveFileNames: () => {
                return false;
            },

            getNewLine: () => {
                return "\n";
            },

            getDefaultLibFileName: (options) => {
                return Plugin.convertToStandardPath(ts.getDefaultLibFilePath(options));
            },

            getCurrentDirectory: () => {
                return filePrefix;
            },

            fileExists: (fileName) => {
                // XXX Use of deprecated method
                // Is this function required by the TypeScript compiler at all?
                return !!filesByPath[fileName] || fs.existsSync(fileName);
            },

            writeFile: (fileName, data, writeByteOrderMark) => {
                compilerOutput[fileName] = data;
            },

            readFile: (fileName) => {
                // Check the Meteor-provided file list first
                if (filesByPath[fileName])
                    return filesByPath[fileName].getContentsAsString();

                // Fall back to reading relative to the working directory, whereever that is
                return fs.readFileSync(filePath, {encoding: "utf8"});
            }
        };

        // Create a program containing this package's files
        // Two different cache layers are applied here: TypeScript reuses parts of the old program
        // (if any), and the compiler host provides ASTs from the document registry if available.
        var oldProgram = packageCache.program || null;
        var newProgram = ts.createProgram(rootFiles, newSettings, compilerHost, oldProgram);

        // Release files which are available in oldProgram but not in newProgram from the cache.
        // Logic from TypeScript's src/services/services.ts.
        if (oldProgram) {
            let oldSourceFiles = oldProgram.getSourceFiles();
            for (let oldSourceFile of oldSourceFiles) {
                let fileName = oldSourceFile.fileName;
                if (!newProgram.getSourceFiles(fileName) || newSettingsChangeSyntax) {
                    this.documentRegistry.releaseDocument(fileName, oldSettings);
                }
            }
        }

        // Update cache
        packageCache.program = newProgram;

        // Compile the package. The compiler host's writeFile method is called here.
        let emitResult = newProgram.emit();
        let allDiagnostics = ts.getPreEmitDiagnostics(newProgram).concat(emitResult.diagnostics);

        // Complain if there are any errors
        // Small inconvenience: Meteor wants us to assign errors to inputFile objects, but that's
        // really not always possible. TypeScript files may reference arbitrary files on the file
        // system, or those in the packages/ directory. Throw an ugly error in such cases.
        allDiagnostics.forEach((e) => {
            let message = ts.flattenDiagnosticMessageText(e.messageText, "\n");
            if (e.file) {
                let { line, character } = e.file.getLineAndCharacterOfPosition(e.start);
                let inputFile = filesByPath[e.file.fileName];
                if (inputFile) {
                    inputFile.error({
                        message: message,
                        line: line,
                        column: character
                    });
                }
                else {
                    throw Error(`TypeScript error while compiling package ${packageName} at `
                        + `${e.file.fileName} (line ${line}:${character}): ${message}`);
                }
            }
            else {
                throw Error(`TypeScript error while compiling package ${packageName}: ${message}`);
            }
        });

        // Register compiler output with Meteor
        for (fileName of rootFiles) {
            let compiledFileName = fileName.splice(0, -3) + ".js";
            let sourceMapFileName = compiledFileName + ".map";
            let inputFile = filesByPath[fileName];

            if (!compilerOutput[compiledFileName])
                continue;

            inputFile.addJavaScript({
                bare: true,
                data: compilerOutput[compiledFileName],
                sourceMap: compilerOutput[sourceMapFileName]
            });
        }

        function findScript(fileName) {
            let meteorFile = filesByPath[fileName];
            if (meteorFile) {
                // Return script data from Meteor
                return {
                    snapshot: ts.ScriptSnapshot.fromString(meteorFile.getContentsAsString()),
                    version: meteorFile.getSourceHash()
                };
            }
            else {
                // Generate script data from disk
                // This part is required for reading through packages/ of Meteor applications.
                try {
                    // XXX Racing condition: fs.statSync should be replaced by fs.fstatSync with a
                    // file handle, but file handles are not supported by Meteor's file system API
                    // wrapper yet.
                    let fileContents = fs.readFileSync(fileName, {encoding: "utf8"});
                    let fileStat = fs.statSync(fileName);
                    return {
                        snapshot: ts.ScriptSnapshot.fromString(fileContents),
                        version: fileStat.mtime.toString()
                    };
                }
                catch (e) {
                    // XXX Test for ENOENT and throw otherwise?
                    return undefined;
                }
            }
        }
    }

    static isDefinitionFile(inputFile) {
        return inputFile.getExtension() == "d.ts";
    }

    static isConfigFile(inputFile) {
        return inputFile.getPathInPackage() == "tsconfig.json";
    }
}

Plugin.registerCompiler({
    extensions: [
        "d.ts", // TypeScript definition files (separate for getExtension() tests)
        "ts",   // TypeScript source files
        "tsx"   // React TypeScript files
    ],
    filenames: [
        "tsconfig.json"
    ]
}, function () {
    return new TSCompiler();
});
