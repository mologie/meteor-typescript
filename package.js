Package.describe({
	name: "mologie:typescript",
	summary: "TypeScript integration for Meteor",
	version: "0.0.1"
});

Package.registerBuildPlugin({
	name: "compile-typescript",
	use: ["underscore"],
	sources: ["plugin/compile-typescript.js"],
	npmDependencies: {
		"typescript": "1.4.1"
	}
});
