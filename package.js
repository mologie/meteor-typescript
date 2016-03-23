// TypeScript for Meteor
// Copyright 2015-2016 Oliver Kuckertz <oliver.kuckertz@mologie.de>
// Refer to COPYING for license information.

var npmPackageList = {
    "typescript": "1.8.9",
    "lodash": "4.6.1"
};

var meteorPackageList = [
    "isobuild:compiler-plugin@1.0.0",
    "ecmascript",
    "modules"
];

Package.describe({
    name: "mologie:typescript",
    summary: "TypeScript integration for Meteor (TypeScript " + npmPackageList["typescript"] + ")",
    git: "https://github.com/mologie/meteor-typescript.git",
    version: "1.1.0-rc.1"
});

Package.onUse(function (api) {
    api.versionsFrom("1.3-rc.8");
    api.use(meteorPackageList);
    api.imply("modules");
});

Package.registerBuildPlugin({
    name: "compile-typescript",
    use: meteorPackageList,
    sources: ["plugin/compile-typescript.js"],
    npmDependencies: npmPackageList
});
