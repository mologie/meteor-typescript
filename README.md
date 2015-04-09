TypeScript for Meteor
=====================

> [TypeScript](http://www.typescriptlang.org/) is a language for application-scale JavaScript. TypeScript adds optional types, classes, and modules to JavaScript. TypeScript supports tools for large-scale JavaScript applications for any browser, for any host, on any OS. TypeScript compiles to readable, standards-based JavaScript.

This package provides TypeScript support for Meteor. It features various caching mechanisms which enable fast incremental builds.

*Bundled TypeScript version: 1.4.1*

**Here be dragons.** Although this package generally seem to work quite well, it has not been extensively tested. Please don't point fingers when things catch fire.


Usage
-----

### Installation

```
meteor add mologie:typescript
```

TypeScript is installed with this package. Once installed, Meteor will accept `.ts` files.

### Using TypeScript

Here are a few simple rules to make things play nicely with Meteor:

* Do not use the `export` or `import` keyword in the top-level scope.
* All moduels and classes (but not variables) declared in the top-level scope are automatically exported to the package/application scope.
* Variables can be exported to the package/application scope by declaring them as part of the global context through TypeScript's `declare` keyword.
* There are no implicit references. You must manually reference all files which your source file depends on.

### TypeScript definitions

This package does not ship with any TypeScript definition files. I maintain a Meteor-specific TypeScript definitions library over at [typescript-libs](//github.com/mologie/meteor-typescript-libs). The [DefinitelyTyped](http://definitelytyped.org) project is an excellent source for TypeScript definitions.


Known issues
------------

* Changing a referenced file which is not part of your package or application does not trigger recompilation.
* The error handling for invalid references is sloppy. It will always display a "file not found" error.
* There are no test cases yet.


License
-------

This package is licensed under the [MIT license](/COPYING).


Credits
-------

This package uses code from various Meteor standard packages and Microsoft's TypeScript compiler API example code.

Inspiration for this package comes from the [meteor-typescript project's plugin](//github.com/meteor-typescript/meteor-typescript-compiler) (MTP), which has been around since 2013. TypeScript has since added an official compiler API. Compared to MTP's plugin, *mologie:typescript* makes use of TypeScript's new API and various caching machanisms, resulting in performance above and beyond MTP's batch compilation approach while avoiding the pitfalls and cosmetic issues that come with batch compilation.
