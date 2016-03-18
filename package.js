// TypeScript for Meteor
// Copyright 2015-2016 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

var npmPackageList = {
    "typescript": "1.8.9",
    "lodash": "^4.6.1"
};

var meteorPackageList = [
    "isobuild:compiler-plugin@1.0.0",
    "ecmascript@0.1.6",
    "underscore@1.0.0"
];

Package.describe({
    name: "mologie:typescript",
    summary: "Minimalistic, battle-tested TypeScript integration for Meteor"
        + " (TypeScript " + npmPackageList["typescript"] + ")",
    git: "https://github.com/mologie/meteor-typescript.git",
    version: "1.0.0"
});

Package.onUse(function (api) {
    api.versionsFrom("METEOR@1.2.0.1");
    api.use(meteorPackageList);
});

Package.registerBuildPlugin({
    name: "compile-typescript",
    use: meteorPackageList,
    sources: ["plugin/compile-typescript.js"],
    npmDependencies: npmPackageList
});
