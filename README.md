TypeScript for Meteor
=====================

> [TypeScript](http://www.typescriptlang.org/) is a language for application-scale JavaScript. TypeScript adds optional types, classes, and modules to JavaScript. TypeScript supports tools for large-scale JavaScript applications for any browser, for any host, on any OS. TypeScript compiles to readable, standards-based JavaScript.

This package provides TypeScript support for Meteor.

*Bundled TypeScript version: 1.4.1*

**Here be dragons.** Although this package generally seem to work quite well, it has not been extensively tested. Please don't point fingers when things catch fire.


Usage
-----

### Installation

```
meteor add mologie:typescript
```

TypeScript is installed with this package. Once installed, Meteor will accept `.ts` files.

### TypeScript definitions

This package does not ship with any TypeScript definition files. I maintain a Meteor-specific TypeScript definitions library over at [typescript-libs](//github.com/mologie/meteor-typescript-libs). The [DefinitelyTyped](http://definitelytyped.org) project is an excellent source for TypeScript definitions.


Known issues
------------

* There is no dependency tracking for referenced files due to limitations of Meteor's compileStep API. This affects other language plugins such as *less* and *stylus* too. Workaround: Restart Meteor if declaration file changes affect your project's files.
* The error handling for invalid references is sloppy. It will always display a "file not found" error.
* There are no test cases yet.


License
-------

This package is licensed under the [MIT license](/COPYING).


Credits
-------

This package uses code from various Meteor standard packages and Microsoft's TypeScript compiler API example code.

Inspiration for this package comes from the [meteor-typescript project's plugin](//github.com/meteor-typescript/meteor-typescript-compiler) (MTP), which has been around since 2013. TypeScript has since added an official compiler API. Compared to MTP's plugin, *mologie:typescript* makes use of TypeScript's new API, resulting in performance comperable to MTP's batch compilation approach while avoiding the pitfalls and cosmetic issues that come with batch compilation.
