TypeScript for Meteor
=====================

> [TypeScript](http://www.typescriptlang.org/) is a language for application-scale JavaScript. TypeScript adds optional types, classes, and modules to JavaScript. TypeScript supports tools for large-scale JavaScript applications for any browser, for any host, on any OS. TypeScript compiles to readable, standards-based JavaScript.

This package provides TypeScript support for Meteor 1.3+ with full CommonJS module support. It features various caching mechanisms which enable fast incremental builds.

*Bundled TypeScript version: 1.8.9*

**Here be dragons.** This package was developed for an upcoming product of ours and generally seem to work quite well, but please don't point fingers when things catch fire. Automated tests are missing.

**Version 1.0.0 of this plugin is not backwards-compatible with previous versions.** Starting with version 1.0.0, TypeScript's standard module system is supported. TypeScript namespaces are no longer exported to Meteor's global scope unless they are explicitly reassigned to a variable defined as global.

Usage
-----

### Installation

Version 1.1.0-rc1 is currently not available on Atmosphere. You can install this release candidate by downloading it into your packages directory:

```
mkdir packages
cd packages
git clone -b develop https://github.com/mologie/meteor-typescript.git
meteor add mologie:typescript
```

Once installed, Meteor will accept `.ts` and `.tsx` files. All syntax-controlling `tsconfig.json` options are supported

### Using TypeScript

This package integrates with Meteor's standard-compliant CommonJS module system. Starting with Meteor 1.3, lazy and eager evaluation are supported. I recommend to exclusively use lazy evaluation in combination with TypeScript's module system an entry point file.

Details about the module system:

https://github.com/meteor/meteor/tree/release-1.3/packages/modules

Differences when using this plugin:

* When referencing TypeScript files using imports in form of `import "./module.ts";`, *the file extension is required*. Imports in form of `import { Answer } from "./universe";` work as expected without specifying a file extension.

#### Application structure

```txt
├── client
│   ├── main.html    Contains your head tag>
│   ├── main.js      Client entry point file (see below)
│   └── stylesheets  Contains .css, .scss etc files
├── imports          All files contained in imports/ are evaluated lazily
│   ├── client       Client .ts, .tsx and .html files
│   ├── model        Files shared between client and server
│   └── server       Server .ts files
├── lib              Place legacy libraries which run before main.js in here
├── public           Meteor resource root
├── server
│   └── main.js      Server entry point file (see below)
├── tests
├── tsconfig.json    Optional TypeScript compiler configuration
├── tslint.json      Go check out the awesome tslint!
├── typings          Written to by the typings tool
└── typings.json     Created by the typings tool
```

Keep in mind: When placing `.html` Blaze templates into `imports/`, then you must explicitly
include them prior to accessing their slot in the global `Template` object. This is not specific
to this plugin, but caused by how Meteor 1.3's module system works. If this is too much of an
inconvenience, then replace the HTML files into `client/` instead of `imports/client/`.

#### Entry point files

```js
// File: client/main.js
Meteor.startup(function () {
    require("../imports/client/index");
    console.log("Application client started");
});
```

```js
// File: server/entrypoint.js
Meteor.startup(function () {
    require("../imports/server/index");
    console.log("Application server started");
});
```

Your `imports/client/index.ts` and `imports/server/index.ts` would then reference other files and
cause the remainder of your application to be loaded on demand.

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

* There are no test cases.
* There are no extensive examples yet, but people familiar with TypeScript should feel right at home.


License
-------

This package is licensed under the [MIT license](/COPYING).
