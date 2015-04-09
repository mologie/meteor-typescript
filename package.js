Package.describe({
	name: "mologie:typescript",
	summary: "TypeScript 1.4.1 with incremental compilation and Windows support",
	git: "https://github.com/mologie/meteor-typescript.git",
	version: "0.0.8"
});

var meteorPackageList = [
    "underscore@1.0.0"
];

var npmPackageList = {
    "typescript": "1.4.1"
};

Package.registerBuildPlugin({
	name: "compile-typescript",
	use: meteorPackageList,
	sources: ["plugin/compile-typescript.js"],
	npmDependencies: npmPackageList
});
