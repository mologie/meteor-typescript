Package.describe({
	name: "mologie:typescript",
	summary: "TypeScript integration for Meteor",
	git: "https://github.com/mologie/meteor-typescript.git",
	version: "0.0.3"
});

Package.registerBuildPlugin({
	name: "compile-typescript",
	use: ["underscore@1.0.0"],
	sources: ["plugin/compile-typescript.js"],
	npmDependencies: {
		"typescript": "1.4.1"
	}
});
