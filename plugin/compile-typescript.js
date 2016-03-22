// TypeScript for Meteor
// Copyright 2015-2016 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

// TODO:
// implement serializing/deserializing document cache for faster startup
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
        this.cache = TSCompiler.acquireCache(this.diskCache);
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
        // XXX Currently, this is redundant, because processFilesForTarget is called once for each
        // architecture.
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
        var ts = this.ts;

        // File index for reverse lookups
        var allFiles = _.keyBy(inputFiles, (file) => {
            let packageName = file.getPackageName();
            let filePrefix = "";
            if (packageName) {
                filePrefix = "packages/" + packageName.replace(":", "/") + "/";
            }
            return filePrefix + file.getPathInPackage();
        });

        // Grab and evaluate tsconfig.json from the application root
        // Embedded packages will inherit settings from the application's tsconfig.json
        let tsconfig = {
            compilerOptions: {},
            files: [],
            exclude: []
        };
        let configFiles = inputFiles.filter(TSCompiler.isConfigFile);
        if (configFiles.length > 0) {
            var configFile = configFiles[0];
            let configText = configFile.getContentsAsString();
            let loadResult = ts.parseConfigFileTextToJson("tsconfig.json", configText);

            if (loadResult.error) {
                let e = loadResult.error;
                let message = ts.flattenDiagnosticMessageText(e.messageText, "\n");
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
                    tsconfig.compilerOptions = ts.convertCompilerOptionsFromJson(
                        ts.optionDeclarations, unprocessedConfig.compilerOptions);
                }

                if (unprocessedConfig.files) {
                    // Add all definition files from tsconfig.json to the compiliation context
                    // This allows omitting a project-wide reference line which would otherwise be
                    // required for each file, while at the same time making editors that depend on
                    // tsconfig.json happy.
                    tsconfig.files = unprocessedConfig.files.filter((fileName) => {
                        // Test if the file is available in the current context (client or server)
                        let inputFile = allFiles[fileName];
                        if (inputFile) {
                            return TSCompiler.isDefinitionFile(inputFile);
                        }

                        // Silently skip loading server-only scripts on the client and client-only
                        // scripts on the server.
                        if (fileName.startsWith("server/") || fileName.startsWith("client/")) {
                            if (!fs.existsSync(fileName)) {
                                configFile.error({
                                    message: "Explicitly referenced file '" + fileName + "' does "
                                        + "not exist."
                                });
                            }
                            return false;
                        }

                        // The file is not part of the Meteor directory. Assume that the user made
                        // a mistake and complain accordingly.
                        configFile.error({
                            message: "Explicitly referenced file '" + fileName + "' was not "
                                + "loaded through Meteor. If this was intentional, place a "
                                + "symlink to the external file into your Meteor project "
                                + "directory."
                        });
                        return false;
                    });
                }

                if (unprocessedConfig.exclude) {
                    // XXX Check that all to-be-excluded files exist here?
                    tsconfig.exclude = unprocessedConfig.exclude;
                }
            }
        }

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
        var ts = this.ts;

        // Heuristics for better embedded package support
        // By rebasing all paths into the package's real directory, referencing files outside of
        // the package becomes possible. Name conflicts between package files and application files
        // are avoided.
        if (packageName) {
            let packageFileName = packageName.replace(":", "_");
            var filePrefix = "packages/" + packageFileName + "/";
            var modulePrefix = "/_modules_/packages/" + packageFileName + "/";
        } else {
            var filePrefix = "";
            var modulePrefix = "/_modules_/app/";
        }

        // For log messages
        let friendlyPackageName = packageName ? `package ${packageName}` : "application";

        // Collect files which need compiling
        var excludedFilesIndex = _.keyBy(tsconfig.exclude, _.identity);
        var rootFiles = [].concat(tsconfig.files);
        inputFiles.forEach((file) => {
            // Don't compile tsconfig.json
            if (TSCompiler.isConfigFile(file)) {
                return;
            }

            // Don't compile files in or under tsconfig.json's excluded files/directories
            // XXX This will break when TypeScript adds globs to tsconfig.json, see
            //     https://github.com/Microsoft/TypeScript/issues/1927
            let fileName = filePrefix + file.getPathInPackage();
            let fileComponents = fileName.split("/");
            for (let i = 0; i < fileComponents.length; i++) {
                if (fileComponents.slice(0, i + 1).join("/") in excludedFilesIndex) {
                    // File or the file's directory have been excluded
                    return;
                }
            }

            rootFiles.push(fileName);
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
                return Plugin.convertToStandardPath(ts.getDefaultLibFilePath(options));
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
            let generatedFileName = inputFile.getPathInPackage().slice(0, -3) + ".js";

            // Get ES3/5 compiler output
            let data = postProcessJs(inputFile, compilerOutput[compiledFileName]);

            // Get source map
            let sourceMap = compilerOutput[sourceMapFileName];
            if (sourceMap) {
                sourceMap = JSON.parse(sourceMap);
                sourceMap.generatedFile = "/" + generatedFileName;
                sourceMap.sources = [inputFile.getDisplayPath()];
            }

            inputFile.addJavaScript({
                sourcePath: inputFile.getPathInPackage(),
                path: generatedFileName,
                data,
                sourceMap,
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

            // Select a module ID
            // The _module_ prefix is required for integration with universe:modules
            let moduleId = modulePrefix + inputFile.getPathInPackage().slice(0, -3);

            // Strip the source map reference - Meteor handles assigning source maps internally
            code = code.replace(/^\/\/# sourceMappingURL=.*$/m, "");

            // Add module name to SystemJS output
            code = code.replace(/^System\.register\(\[/m, `System.register("${moduleId}", [`);

            return code;
        }

        function loadPackageConfig() {
            let suggestedOptions = {
                charset: "utf8",
                preverseConstEnums: true,
                module: ts.ModuleKind.System
            };

            let enforcedOptions = {
                declaration: false,
                diagnostics: true,
                emitBOM: false,
                inlineSourceMap: false,
                inlineSources: true,
                mapRoot: "",
                sourceMap: true,
                noEmit: false,
                noEmitHelpers: false,
                noEmitOnError: true,
                out: undefined,
                outFile: undefined,
                target: (arch == "web.browser") ? ts.ScriptTarget.ES3 : ts.ScriptTarget.ES5
            };

            return _.assign(
                {},
                ts.getDefaultCompilerOptions(),
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
            // from disk on demand. We unfortunately cannot rely on inputFile.getSourceHash()
            // because its algorithm is not documented.
            let version = crypto.createHash("sha1").update(contents).digest("hex");

            return {
                snapshot: ts.ScriptSnapshot.fromString(contents),
                version: version
            };
        }

        function logError(e) {
            // Small inconvenience: Meteor wants us to assign errors to inputFile objects, but
            // that's really not always possible. TypeScript files may reference arbitrary files on
            // the file system (at least lib.d.ts). Throw an ugly error in such cases.
            let message = ts.flattenDiagnosticMessageText(e.messageText, "\n");
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
