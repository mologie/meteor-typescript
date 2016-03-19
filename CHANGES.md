# ChangeLog

### 1.0.0 (TypeScript 1.8.9)

* Rewrite for Meteor 1.2 build API
* Use TypeScript 1.8
* Use SystemJS (via `universe:modules`)
* Support configuration via `tsconfig.json`

Breaking changes:

* [TypeScript breaking changes](https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#typescript-18)

### 0.0.9 (TypeScript 1.4.1)

* Incremental builds now work correctly on Windows

### 0.0.8 (TypeScript 1.4.1)

* Support for Windows

### 0.0.7 (TypeScript 1.4.1)

* Fix crash when encountering circular reference

### 0.0.6 (TypeScript 1.4.1)

* Cache and reuse syntax tree and JavaScript output
* Incrementally rebuild application if referenced files change

### 0.0.5 (TypeScript 1.4.1)

* Report consistent relative paths in error messages

### 0.0.4 (TypeScript 1.4.1)

* Target ES3 when building for the browser

### 0.0.3 (TypeScript 1.4.1)

* Fix reserved path error when including multiple files with equal names from different directories
