// TypeScript for Meteor
// Copyright 2015-2016 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

// TODO:
// implement serializing/deserializing document cache
// update readme, explain how this is not the big other typescript compiler plugin
//  - faster, more up-to-date, minimalistic, input AST caching, package support, mixing different
//    file types (TS, JS), source map support
//  - document that export = null is required for switching to local scope mode

var fs     = Plugin.fs;
var path   = Plugin.path;
var meteor = this;
var crypto = Npm.require("crypto");
var _      = Npm.require("lodash");

const ENABLE_AGGRESSIVE_CACHING = false; // ignore requests from Meteor to invalidate the cache

class TSCompiler {
    constructor() {
        this.cache = null;
    }

    setDiskCacheDirectory(diskCache) {
        // Meteor calls setDiskCacheDirectory immediately after creating the TSCompiler class.
        // Some Meteor plugins have the same check, so this will probably last.
        if (this.diskCache) {
            throw Error("setDiskCacheDirectory called twice");
        }
        this.diskCache = diskCache;
        this.loadDocumentCache();
    }

    loadDocumentCache() {
        // Reuse the previous cache if one is available. Minor hack: Meteor's disk cache path is
        // is for testing if the cache should be invalidated. The disk cache path will change when
        // this plugin updates or dependencies of the application change.
        this.cache = acquireCache(this.diskCache);
        this.ts = (this.cache.ts || (this.cache.ts = Npm.require("typescript")));
        this.documentRegistry = (this.cache.documentRegistry
            || (this.cache.documentRegistry = this.ts.createDocumentRegistry()));
        this.archCache = (this.cache.archCache || (this.cache.archCache = {}));

        // TODO populate documentRegistry from disk for faster startup
    }

    saveDocumentCache() {
        // TODO serialize documentRegistry to disk
    }

    processFilesForTarget(inputFiles) {
        // Sanity check
        if (!this.cache) {
            throw Error("processFilesForTarget called before setDiskCacheDirectory");
        }

        // Process each architecture
        let filesPerArch = _.groupBy(inputFiles, (file) => file.getArch());
        for (let arch of Object.keys(filesPerArch)) {
            if (!(arch in this.archCache)) {
                this.archCache[arch] = {};
            }
            this.processFilesForArch(arch, this.archCache[arch], filesPerArch[arch]);
        }

        // Sync cache to disk
        this.saveDocumentCache();
    }

    processFilesForArch(arch, archCache, inputFiles) {
        // Grab and evaluate tsconfig.json from the application root
        // Embedded package will inherit settings from the application's tsconfig.json
        let tsconfig = {
            compilerOptions: {},
            files: []
        };
        let configFiles = inputFiles.filter(TSCompiler.isConfigFile);
        if (configFiles.length > 0) {
            let configFile = configFiles[0];
            let configText = configFile.getContentsAsString();
            let loadResult = this.ts.parseConfigFileTextToJson("tsconfig.json", configText);

            if (loadResult.error) {
                let e = loadResult.error;
                let message = this.ts.flattenDiagnosticMessageText(e.messageText, "\n");
                let { line, character } = e.file.getLineAndCharacterOfPosition(e.start);
                configFile.error({
                    message: message,
                    line: line,
                    column: character
                });
            }
            else if (loadResult.config) {
                let unprocessedConfig = loadResult.config;

                if (unprocessedConfig.compilerOptions) {
                    tsconfig.compilerOptions = this.ts.convertCompilerOptionsFromJson(
                        this.ts.optionDeclarations, unprocessedConfig.compilerOptions);
                }

                if (unprocessedConfig.files) {
                    // XXX It may cause trouble to allow the user to load arbitrary files here
                    tsconfig.files = unprocessedConfig.files;
                }
            }
        }

        // File index for reverse lookups
        var allFiles = _.keyBy(inputFiles, (file) => {
            let packageName = file.getPackageName();
            let buildingEmbeddedPackage = packageName && fs.existsSync("packages/" + packageName);
            var filePrefix = "";
            if (buildingEmbeddedPackage) {
                filePrefix = "packages/" + packageName + "/";
            }
            return filePrefix + file.getPathInPackage();
        });

        // Process files per package
        // Meteor performs garbage collection automatically by destryoing TSCompiler if the list
        // of embedded packages changes.
        let filesPerPackage = _.groupBy(inputFiles, (file) => file.getPackageName() || "");
        for (let packageName of Object.keys(filesPerPackage)) {
            if (!(packageName in archCache)) {
                archCache[packageName] = {};
            }
            this.processFilesForPackage(packageName, archCache[packageName], arch,
                filesPerPackage[packageName], allFiles, tsconfig);
        }
    }

    processFilesForPackage(packageName, packageCache, arch, inputFiles, allFiles, tsconfig) {
        // Heuristics for better embedded package support
        // By rebasing all paths into the package's real directory, referencing files outside of
        // the package becomes possible. Name conflicts between package files and application files
        // are avoided.
        let buildingEmbeddedPackage = packageName && fs.existsSync("packages/" + packageName);
        var filePrefix = "";
        if (buildingEmbeddedPackage) {
            filePrefix = "packages/" + packageName + "/";
        }

        // For log messages
        let friendlyPackageName = packageName ? `package ${packageName}` : "application";

        // Collect files which need compiling
        var rootFiles = [].concat(tsconfig.files);
        inputFiles.forEach((file) => {
            if (!TSCompiler.isDefinitionFile(file) && !TSCompiler.isConfigFile(file)) {
                rootFiles.push(filePrefix + file.getPathInPackage());
            }
        });

        // Process configuration
        // Syntax change test taken from TypeScript's src/services/services.ts
        var oldSettings = packageCache.program && packageCache.program.getCompilerOptions();
        var newSettings = loadPackageConfig();
        var newSettingsChangeSyntax = oldSettings &&
            (oldSettings.target !== newSettings.target ||
             oldSettings.module !== newSettings.module ||
             oldSettings.noResolve !== newSettings.noResolve ||
             oldSettings.jsx !== newSettings.jsx);

        // Compiler host specific to this package and architecture
        var compilerOutput = {};
        var compilerHost = {
            getSourceFile: (fileName) => {
                let script = findScript(fileName);
                if (!script) {
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
                return Plugin.convertToStandardPath(this.ts.getDefaultLibFilePath(options));
            },

            getCurrentDirectory: () => {
                return filePrefix;
            },

            fileExists: (fileName) => {
                // XXX Use of deprecated method
                // Is this function required by the TypeScript compiler at all?
                return !!allFiles[fileName] || fs.existsSync(fileName);
            },

            writeFile: (fileName, data, writeByteOrderMark) => {
                compilerOutput[fileName] = data;
            },

            readFile: (fileName) => {
                // Check the Meteor-provided file list first
                if (allFiles[fileName]) {
                    return allFiles[fileName].getContentsAsString();
                }

                // Fall back to reading relative to the working directory, whereever that is
                return fs.readFileSync(filePath, {encoding: "utf8"});
            }
        };

        // Create a program containing this package's files
        // Two different cache layers are applied here: TypeScript reuses parts of the old program
        // (if any), and the compiler host provides ASTs from the document registry if available.
        var oldProgram = packageCache.program || null;
        var newProgram = this.ts.createProgram(rootFiles, newSettings, compilerHost, oldProgram);

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
        let allDiagnostics =
            this.ts.getPreEmitDiagnostics(newProgram).concat(emitResult.diagnostics);

        // Complain if there are any errors
        allDiagnostics.forEach(logError);

        // Register compiler output with Meteor
        for (let fileName of rootFiles) {
            let compiledFileName = fileName.slice(0, -3) + ".js";
            let sourceMapFileName = compiledFileName + ".map";
            let inputFile = allFiles[fileName];

            if (!compilerOutput[compiledFileName]) {
                continue;
            }

            // Drop the packages/<name>/ prefix
            let meteorFilePath = inputFile.getPathInPackage().slice(0, -3) + ".js";

            inputFile.addJavaScript({
                bare: true,
                data: postProcessJs(inputFile, compilerOutput[compiledFileName]),
                sourceMap: postProcessSourceMap(inputFile, compilerOutput[sourceMapFileName]),
                path: meteorFilePath
            });
        }

        function postProcessJs(inputFile, code) {
            // Bail out if a file operates in global scope
            if (code.indexOf("System.register") == -1) {
                inputFile.error({
                    message: "File does not have a top-level import or export statement. "
                        + "Did you forget to 'export default null'?"
                });
                return code;
            }

            // Select a module name, which will be similar to the file name without file extension.
            // Application files have no prefix
            // Package files get {package-name}/ as prefix
            let module = filePrefix + inputFile.getPathInPackage().slice(0, -3);

            // Strip the source map reference - Meteor handles assigning source maps internally
            code = code.replace(/^\/\/# sourceMappingURL=.*$/m, "");

            // Add module name to SystemJS output
            code = code.replace(/^System\.register\(\[/m, "System.register(\"" + module + "\", [");

            return code;
        }

        function postProcessSourceMap(inputFile, encodedSourceMap) {
            // Embed the input file into the source map (with the path suggested by Meteor's build
            // system), because Meteor won't serve the original .ts files to the browser.
            let sourceMap = JSON.parse(encodedSourceMap);
            sourceMap.sourceContent = [inputFile.getContentsAsString()];
            sourceMap.sources = [inputFile.getDisplayPath()];
            return sourceMap;
        }

        function loadPackageConfig() {
            let suggestedOptions = {
                charset: "utf8",
                preverseConstEnums: true,
                module: this.ts.ModuleKind.System
            };

            let enforcedTarget = (arch == "web.browser")
                ? this.ts.ScriptTarget.ES3
                : this.ts.ScriptTarget.ES5;

            let enforcedOptions = {
                declaration: false,
                diagnostics: true,
                emitBOM: false,
                inlineSourceMap: false,
                inlineSources: false,
                mapRoot: filePrefix,
                sourceMap: true,
                noEmit: false,
                noEmitHelpers: false,
                noEmitOnError: true,
                out: undefined,
                outFile: undefined,
                target: enforcedTarget
            };

            return _.assign(
                {},
                this.ts.getDefaultCompilerOptions(),
                suggestedOptions,
                tsconfig.compilerOptions,
                enforcedOptions
            );
        }

        function findScript(fileName) {
            let contents;

            if (allFiles[fileName]) {
                contents = allFiles[fileName].getContentsAsString();
            }
            else {
                // Read script from disk
                try {
                    // XXX Cache the result of readFileSync until processFilesForTarget returns
                    contents = fs.readFileSync(fileName, {encoding: "utf8"});
                }
                catch (e) {
                    // XXX Test for ENOENT and rethrow otherwise?
                    return undefined;
                }
            }

            // Use a custom checksum for synchronization of the Meteor file cache and of files read
            // from disk on demand. We unfortunately cannot rely on meteorFile.getSourceHash()
            // because its algorithm is not documented.
            let version = crypto.createHash("sha1").update(contents).digest("hex");

            return {
                snapshot: this.ts.ScriptSnapshot.fromString(contents),
                version: version
            };
        }

        function logError(e) {
            // Small inconvenience: Meteor wants us to assign errors to inputFile objects, but
            // that's really not always possible. TypeScript files may reference arbitrary files on
            // the file system (at least lib.d.ts). Throw an ugly error in such cases.
            let message = this.ts.flattenDiagnosticMessageText(e.messageText, "\n");
            if (e.file) {
                let { line, character } = e.file.getLineAndCharacterOfPosition(e.start);
                let inputFile = allFiles[e.file.fileName];
                if (inputFile) {
                    inputFile.error({
                        message: message,
                        line: line,
                        column: character
                    });
                }
                else {
                    throw Error(`TypeScript error while compiling ${friendlyPackageName} at `
                        + `${e.file.fileName} (line ${line}:${character}): ${message}`);
                }
            }
            else {
                throw Error(`TypeScript error while compiling ${friendlyPackageName}: ${message}`);
            }
        }
    }

    static isDefinitionFile(inputFile) {
        return inputFile.getExtension() == "d.ts";
    }

    static isConfigFile(inputFile) {
        return inputFile.getPathInPackage() == "tsconfig.json";
    }

    // Meteor will recreate an instance of TSCompiler each time the application is rebuilt.
    // In order to persist the cache across rebuilds in memory, a reference to the cache is stored
    // with the global context.
    static acquireCache(token) {
        let cache = meteor.__typescriptCache;
        if (cache && (cache.token == token || ENABLE_AGGRESSIVE_CACHING)) {
            return cache;
        }
        meteor.__typescriptCache = {};
        meteor.__typescriptCache.token = token;
        return meteor.__typescriptCache;
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

/* vim: set ts=4 sw=4 sts=4 et : */
