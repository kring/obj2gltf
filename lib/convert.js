"use strict";
var path = require('path');
var GltfPipeline = require('gltf-pipeline').Pipeline;
var parseObj = require('./obj');
var createGltf = require('./gltf');
var Cesium = require('cesium');
var defined = Cesium.defined;
var defaultValue = Cesium.defaultValue;

module.exports = convert;

function convert(objFile, outputPath, options) {
    options = defaultValue(options, {});
    var binary = defaultValue(options.binary, false);
    var embed = defaultValue(options.embed, true);
    var embedImage = defaultValue(options.embedImage, true);
    var compress = defaultValue(options.compress, false);
    var ao = defaultValue(options.ao, false);
    var optimizeForCesium = defaultValue(options.optimizeForCesium, false);

    if (!defined(objFile)) {
        throw new Error('objFile is required');
    }

    if (!defined(outputPath)) {
        outputPath = path.dirname(objFile);
    }

    var inputPath = path.dirname(objFile);
    var modelName = path.basename(objFile, '.obj');

    var extension = path.extname(outputPath);
    if (extension !== '') {
        modelName = path.basename(outputPath, extension);
        outputPath = path.dirname(outputPath);
    }

    extension = binary ? '.glb' : '.gltf';
    var gltfFile = path.join(outputPath, modelName + extension);

    return parseObj(objFile, inputPath)
        .then(function(data) {
            return createGltf(data, inputPath, modelName);
        })
        .then(function(gltf) {
            var aoOptions = ao ? {} : undefined;
            var options = {
                binary: binary,
                embed: embed,
                embedImage: embedImage,
                encodeNormals: compress,
                quantize: compress,
                aoOptions: aoOptions,
                optimizeForCesium : optimizeForCesium,
                createDirectory: false,
                basePath: inputPath
            };
            return GltfPipeline.processJSONToDisk(gltf, gltfFile, options);
        });
}
