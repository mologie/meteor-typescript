TypeScript for Meteor
=====================

> [TypeScript](http://www.typescriptlang.org/) is a language for application-scale JavaScript. TypeScript adds optional types, classes, and modules to JavaScript. TypeScript supports tools for large-scale JavaScript applications for any browser, for any host, on any OS. TypeScript compiles to readable, standards-based JavaScript.

This package provides TypeScript support for Meteor. It features various caching mechanisms which enable fast incremental builds.

*Bundled TypeScript version: 1.8.9*

**Here be dragons.** This package generally seem to work quite well, but please don't point fingers when things catch fire. Automated tests are missing.

**Version 1.0.0 of this plugin is not backwards-compatible with previous versions.** Starting with version 1.0.0, TypeScript's module system is supported. Modules are no longer exported to the global scope.

**This package is currently being updated for Meteor 1.3's CommonJS module system.** No syntax changes will be required. The Meteor 1.3 update will ship as minor update (1.1.0).

Usage
-----

### Installation

Version 1.0.0-rc1 is currently not available on Atmosphere. You can install this release candidate by downloading it into your packages directory:

```
mkdir packages
cd packages
git clone -b develop https://github.com/mologie/meteor-typescript.git
meteor add mologie:typescript
```

Once installed, Meteor will accept `.ts` and `.tsx` files. All syntax-controlling `tsconfig.json` options are supported

### Using TypeScript

This packages uses `universe:modules` for SystemJS support. TypeScript files are only run when referenced. Therefore, you will need an entry point on client and server. If `client/index.ts` was your client entry point, then your entry point file might look like this:

```js
// File: client/entrypoint.js
Meteor.startup(function () {
    System.import("/client/index");
});
```

Meteor currently eats exceptions thrown in promises on the server, so that printing a stack trace yourself is useful for debugging:

```js
// File: server/entrypoint.js
Meteor.startup(function () {
    System.import("/server/index").then(
        function () {
            console.log("Application started");
        },
        function (e) {
            console.log("Application server crashed during startup :(");
            if (e.stack) {
                console.log("Stack trace:");
                console.log(e.stack);
            }
            else {
                console.log(e);
            }
        }
    );
});
```

### TypeScript definitions

This package does not ship with any TypeScript definition files. The [DefinitelyTyped](http://definitelytyped.org) project is an excellent source for TypeScript definitions. When using DefinitelyTyped's `typings` tool with Meteor, the following `tsconfig.json` will make this plugin, VS Code and Sublime Text properly load your definition files:

```json
{
    "exclude": [
        ".meteor",
        "typings/browser",
        "typings/browser.d.ts"
    ]
}
```

Known issues
------------

* Meteor 1.2 occasionally delivers empty source maps.
* There are no test cases.
* There are no extensive examples yet, but people familiar with TypeScript should feel right at home.


License
-------

This package is licensed under the [MIT license](/COPYING).
