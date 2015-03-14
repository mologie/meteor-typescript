# mologie:typescript

*Bundled TypeScript version: 1.4.1*

This package provides TypeScript support for Meteor.

> [TypeScript](http://www.typescriptlang.org/) is a language for
> application-scale JavaScript. TypeScript adds optional types, classes,
> and modules to JavaScript. TypeScript supports tools for large-scale
> JavaScript applications for any browser, for any host, on any
> OS. TypeScript compiles to readable, standards-based JavaScript. Try
> it out at the [playground](http://www.typescriptlang.org/Playground),
> and stay up to date via [our blog](http://blogs.msdn.com/typescript)
> and [twitter account](https://twitter.com/typescriptlang).

## Usage

```
meteor add mologie:typescript
```

TypeScript is installed with this package. Once installed, Meteor will accept
`.ts` files.

This package does not ship with any TypeScript definition files. I maintain a
Meteor-specific TypeScript definitions library over at
[typescript-libs](//mologie/meteor-typescript-libs). The
[DefinitelyTyped](http://definitelytyped.org) project is an excellent source
for TypeScript definitions.


## Known issues

* There is no dependency tracking for reference tracking due to limitations of Meteor's compileStep API. This affects other language plugins such as less and stylus too. Workaround: Restart Meteor if declaration files changed and affect your project files.
* Sloppy error handling for invalid references (will always display "file not found").
* There are no test cases yet.


## License

MIT


## Credits

This plugin uses code from various Meteor standard packages and Microsoft's
TypeScript compiler API example code.
