"use strict";

var Cesium = require('cesium');
var Promise = require('bluebird');
var byline = require('byline');
var fs = require('fs-extra');
var path = require('path');

var loadImage = require('./image');
var Material = require('./mtl');

var Cartesian3 = Cesium.Cartesian3;
var defined = Cesium.defined;

module.exports = parseObj;

// OBJ regex patterns are from ThreeJS (https://github.com/mrdoob/three.js/blob/master/examples/js/loaders/OBJLoader.js)

function parseObj(objFile, inputPath) {
    return getObjInfo(objFile, inputPath)
        .then(function(result) {
            var info = result.info;
            var materials = result.materials;
            var images = result.images;
            return processObj(objFile, info, materials, images);
        });
}

function processObj(objFile, info, materials, images) {
    return new Promise(function(resolve) {
        // A vertex is specified by indexes into each of the attribute arrays,
        // but these indexes may be different. This maps the separate indexes to a single index.
        var vertexCache = {};
        var vertexCount = 0;

        var vertexArray = [];

        var positions = [];
        var normals = [];
        var uvs = [];

        var positionMin = [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE];
        var positionMax = [-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];

        var hasNormals = info.hasNormals;
        var hasUVs = info.hasUVs;

        var materialGroups = {}; // Map material to index array
        var currentIndexArray;

        // Switch to the material-specific index array, or create it if it doesn't exist
        function useMaterial(material) {
            if (!defined(materials[material])) {
                useDefaultMaterial();
            } else {
                currentIndexArray = materialGroups[material];
                if (!defined(currentIndexArray)) {
                    currentIndexArray = [];
                    materialGroups[material] = currentIndexArray;
                }
            }
        }

        function useDefaultMaterial() {
            var defaultMaterial = 'czmDefaultMat';
            if (!defined(materials[defaultMaterial])) {
                materials[defaultMaterial] = Material.getDefault();
            }
            useMaterial(defaultMaterial);
        }

        var materialsLength = Object.keys(materials).length;
        if (materialsLength === 0) {
            useDefaultMaterial();
        }

        function getOffset(a, data, components) {
            var i = parseInt(a);
            if (i < 0) {
                // Negative vertex indexes reference the vertices immediately above it
                return (data.length / components + i) * components;
            }
            return (i - 1) * components;
        }

        function createVertex(p, u, n) {
            // Positions
            var pi = getOffset(p, positions, 3);
            var px = positions[pi + 0];
            var py = positions[pi + 1];
            var pz = positions[pi + 2];

            positionMin[0] = Math.min(px, positionMin[0]);
            positionMin[1] = Math.min(py, positionMin[1]);
            positionMin[2] = Math.min(pz, positionMin[2]);
            positionMax[0] = Math.max(px, positionMax[0]);
            positionMax[1] = Math.max(py, positionMax[1]);
            positionMax[2] = Math.max(pz, positionMax[2]);
            vertexArray.push(px, py, pz);

            // Normals
            if (hasNormals) {
                var ni = getOffset(n, normals, 3);
                var nx = normals[ni + 0];
                var ny = normals[ni + 1];
                var nz = normals[ni + 2];
                vertexArray.push(nx, ny, nz);
            }

            // UVs
            if (hasUVs) {
                if (defined(u)) {
                    var ui = getOffset(u, uvs, 2);
                    var ux = uvs[ui + 0];
                    var uy = uvs[ui + 1];
                    // Flip y so 0.0 is the bottom of the image
                    uy = 1.0 - uy;
                    vertexArray.push(ux, uy);
                } else {
                    // Some objects in the model may not have uvs, fill with 0's for consistency
                    vertexArray.push(0.0, 0.0);
                }
            }
        }

        function addVertex(v, p, u, n) {
            var index = vertexCache[v];
            if (!defined(index)) {
                index = vertexCount++;
                vertexCache[v] = index;
                createVertex(p, u, n);
            }

            return index;
        }

        function addFace(simpleVertices, v1, p1, u1, n1, v2, p2, u2, n2, v3, p3, u3, n3, v4, p4, u4, n4) {
            if (simpleVertices) {
                currentIndexArray.push(p1 - 1, p2 - 1, p3 - 1);
                if (defined(p4)) {
                    currentIndexArray.push(p1 - 1, p3 - 1, p4 - 1);
                }
                return;
            }
            var index1 = addVertex(v1, p1, u1, n1);
            var index2 = addVertex(v2, p2, u2, n2);
            var index3 = addVertex(v3, p3, u3, n3);

            currentIndexArray.push(index1);
            currentIndexArray.push(index2);
            currentIndexArray.push(index3);

            // Triangulate if the face is a quad
            if (defined(v4)) {
                var index4 = addVertex(v4, p4, u4, n4);
                currentIndexArray.push(index1);
                currentIndexArray.push(index3);
                currentIndexArray.push(index4);
            }
        }

        // v float float float
        var vertexPattern = /v( +[\d|\.|\+|\-|e|E]+)( +[\d|\.|\+|\-|e|E]+)( +[\d|\.|\+|\-|e|E]+)/;

        // vn float float float
        var normalPattern = /vn( +[\d|\.|\+|\-|e|E]+)( +[\d|\.|\+|\-|e|E]+)( +[\d|\.|\+|\-|e|E]+)/;

        // vt float float
        var uvPattern = /vt( +[\d|\.|\+|\-|e|E]+)( +[\d|\.|\+|\-|e|E]+)/;

        // f vertex vertex vertex ...
        var facePattern1 = /f( +-?\d+)\/?( +-?\d+)\/?( +-?\d+)\/?( +-?\d+)?\/?/;

        // f vertex/uv vertex/uv vertex/uv ...
        var facePattern2 = /f( +(-?\d+)\/(-?\d+)\/?)( +(-?\d+)\/(-?\d+)\/?)( +(-?\d+)\/(-?\d+)\/?)( +(-?\d+)\/(-?\d+)\/?)?/;

        // f vertex/uv/normal vertex/uv/normal vertex/uv/normal ...
        var facePattern3 = /f( +(-?\d+)\/(-?\d+)\/(-?\d+))( +(-?\d+)\/(-?\d+)\/(-?\d+))( +(-?\d+)\/(-?\d+)\/(-?\d+))( +(-?\d+)\/(-?\d+)\/(-?\d+))?/;

        // f vertex//normal vertex//normal vertex//normal ...
        var facePattern4 = /f( +(-?\d+)\/\/(-?\d+))( +(-?\d+)\/\/(-?\d+))( +(-?\d+)\/\/(-?\d+))( +(-?\d+)\/\/(-?\d+))?/;

        var positionCount = 0;
        var normalCount = 0;
        var uvCount = 0;
        var triangleCount = 0;
        var simpleVertices = true;

        // Do a first pass to count the vertices and triangles, and to determine if the vertices are all simple.
        // A simple vertex has the same index for position, normal, and uv.
        var previewStream = byline(fs.createReadStream(objFile, {encoding: 'utf8'}));
        previewStream.on('data', function (line) {
            line = line.trim();
            var result;
            if ((line.length === 0) || (line.charAt(0) === '#')) {
                // Don't process empty lines or comments
            } else if ((result = vertexPattern.exec(line)) !== null) {
                ++positionCount;
            } else if ((result = normalPattern.exec(line) ) !== null) {
                ++normalCount;
            } else if ((result = uvPattern.exec(line)) !== null) {
                ++uvCount;
            } else if ((result = facePattern1.exec(line)) !== null) {
                triangleCount += defined(result[4]) ? 2 : 1;
            } else if ((result = facePattern2.exec(line)) !== null) {
                triangleCount += defined(result[10]) ? 2 : 1;
                simpleVertices &= result[2] === result[3] &&
                                  result[5] === result[6] &&
                                  result[8] === result[9] &&
                                  result[11] === result[12];
            } else if ((result = facePattern3.exec(line)) !== null) {
                triangleCount += defined(result[3]) ? 2 : 1;
                simpleVertices &= result[2] === result[3] && result[3] === result[4] &&
                                  result[6] === result[7] && result[7] === result[8] &&
                                  result[10] === result[11] && result[11] === result[12] &&
                                  result[14] === result[15] && result[15] === result[16];
            } else if ((result = facePattern4.exec(line)) !== null) {
                triangleCount += defined(result[10]) ? 2 : 1;
                simpleVertices &= result[2] === result[3] &&
                                  result[5] === result[6] &&
                                  result[8] === result[9] &&
                                  result[11] === result[12];
            }
        });
        previewStream.on('end', function () {
            var totalVertices;
            var vertexSize;
            if (simpleVertices) {
                console.log('simple!');
                if (normalCount > 0 && positionCount !== normalCount || uvCount > 0 && positionCount !== uvCount) {
                    simpleVertices = false;
                } else {
                    console.log('still!');
                    vertexSize = 3 + (normalCount > 0 ? 3 : 0) + (uvCount > 0 ? 2 : 0);
                    console.log('vertexSize ' + vertexSize);
                    console.log('positionCount ' + positionCount);
                    vertexArray = new Float64Array(positionCount * vertexSize);
                    console.log(vertexArray.length);

                    vertexCount = positionCount;
                    positionCount = 0;
                    normalCount = 0;
                    uvCount = 0;
                }
            } else {
                console.log('not simple');
            }

            var normalScratch = new Cartesian3();

            var stream = byline(fs.createReadStream(objFile, {encoding: 'utf8'}));
            stream.on('data', function (line) {
                line = line.trim();
                var result;
                if ((line.length === 0) || (line.charAt(0) === '#')) {
                    // Don't process empty lines or comments
                } else if ((result = vertexPattern.exec(line)) !== null) {
                    var x = parseFloat(result[1]);
                    var y = parseFloat(result[2]);
                    var z = parseFloat(result[3]);

                    if (simpleVertices) {
                        var positionIndex = positionCount * vertexSize;
                        vertexArray[positionIndex] = x;
                        vertexArray[positionIndex + 1] = y;
                        vertexArray[positionIndex + 2] = z;
                        ++positionCount;

                        positionMin[0] = Math.min(x, positionMin[0]);
                        positionMin[1] = Math.min(y, positionMin[1]);
                        positionMin[2] = Math.min(z, positionMin[2]);
                        positionMax[0] = Math.max(x, positionMax[0]);
                        positionMax[1] = Math.max(y, positionMax[1]);
                        positionMax[2] = Math.max(z, positionMax[2]);
                    } else {
                        positions.push(x, y, z);
                    }
                } else if ((result = normalPattern.exec(line) ) !== null) {
                    var nx = parseFloat(result[1]);
                    var ny = parseFloat(result[2]);
                    var nz = parseFloat(result[3]);
                    
                    var normal = Cartesian3.normalize(Cartesian3.fromElements(nx, ny, nz, normalScratch), normalScratch);
                    if (simpleVertices) {
                        var normalIndex = normalCount * vertexSize + 3;
                        vertexArray[normalIndex] = normal.x;
                        vertexArray[normalIndex + 1] = normal.y;
                        vertexArray[normalIndex + 2] = normal.z;
                        ++normalCount;
                    } else {
                        normals.push(normal.x, normal.y, normal.z);
                    }
                } else if ((result = uvPattern.exec(line)) !== null) {
                    var u = parseFloat(result[1]);
                    var v = parseFloat(result[2]);

                    if (simpleVertices) {
                        var uvIndex = uvCount * vertexSize + 3 + (hasNormals ? 3 : 0);
                        vertexArray[uvIndex] = u;
                        vertexArray[uvIndex + 1] = 1.0 - v; // Flip y so 0.0 is the bottom of the image
                        ++uvCount;
                    } else {
                        uvs.push(u, v);
                    }
                } else if ((result = facePattern1.exec(line)) !== null) {
                    addFace(simpleVertices,
                        result[1], result[1], undefined, undefined,
                        result[2], result[2], undefined, undefined,
                        result[3], result[3], undefined, undefined,
                        result[4], result[4], undefined, undefined
                    );
                } else if ((result = facePattern2.exec(line)) !== null) {
                    addFace(simpleVertices,
                        result[1], result[2], result[3], undefined,
                        result[4], result[5], result[6], undefined,
                        result[7], result[8], result[9], undefined,
                        result[10], result[11], result[12], undefined
                    );
                } else if ((result = facePattern3.exec(line)) !== null) {
                    addFace(simpleVertices,
                        result[1], result[2], result[3], result[4],
                        result[5], result[6], result[7], result[8],
                        result[9], result[10], result[11], result[12],
                        result[13], result[14], result[15], result[16]
                    );
                } else if ((result = facePattern4.exec(line)) !== null) {
                    addFace(simpleVertices,
                        result[1], result[2], undefined, result[3],
                        result[4], result[5], undefined, result[6],
                        result[7], result[8], undefined, result[9],
                        result[10], result[11], undefined, result[12]
                    );
                } else if (/^usemtl /.test(line)) {
                    var materialName = line.substring(7).trim();
                    useMaterial(materialName);
                }
            });

            stream.on('end', function () {
                console.log('vertex count ' + vertexCount);
                console.log('vertexArray.length ' + vertexArray.length);
                console.log('keys ' + Object.keys(vertexCache).length);
                resolve({
                    vertexCount: vertexCount,
                    vertexArray: vertexArray,
                    positionMin: positionMin,
                    positionMax: positionMax,
                    hasUVs: hasUVs,
                    hasNormals: hasNormals,
                    materialGroups: materialGroups,
                    materials: materials,
                    images: images
                });
            });
        });
    });
}

function getImages(inputPath, materials) {
    // Collect all the image files from the materials
    var images = [];
    for (var name in materials) {
        if (materials.hasOwnProperty(name)) {
            var material = materials[name];
            if (defined(material.ambientColorMap) && (images.indexOf(material.ambientColorMap) === -1)) {
                images.push(material.ambientColorMap);
            }
            if (defined(material.diffuseColorMap) && (images.indexOf(material.diffuseColorMap) === -1)) {
                images.push(material.diffuseColorMap);
            }
            if (defined(material.emissionColorMap) && (images.indexOf(material.emissionColorMap) === -1)) {
                images.push(material.emissionColorMap);
            }
            if (defined(material.specularColorMap) && (images.indexOf(material.specularColorMap) === -1)) {
                images.push(material.specularColorMap);
            }
        }
    }

    // Load the image files
    var promises = [];
    var imagesInfo = {};
    var imagesLength = images.length;
    for (var i = 0; i < imagesLength; i++) {
        var imagePath = images[i];
        if (!path.isAbsolute(imagePath)) {
            imagePath = path.join(inputPath, imagePath);
        }
        promises.push(loadImage(imagePath));
    }
    return Promise.all(promises)
        .then(function(imageInfoArray) {
            var imageInfoArrayLength = imageInfoArray.length;
            for (var j = 0; j < imageInfoArrayLength; j++) {
                var image = images[j];
                var imageInfo = imageInfoArray[j];
                imagesInfo[image] = imageInfo;
            }
            return imagesInfo;
        });
}

function getMaterials(mtlPath, hasMaterialGroups) {
    if (hasMaterialGroups && defined(mtlPath)) {
        return Material.parse(mtlPath);
    }

    return {};
}

function getObjInfo(objFile, inputPath) {
    var mtlPath;
    var materials;
    var info;
    var hasMaterialGroups = false;
    var hasPositions = false;
    var hasNormals = false;
    var hasUVs = false;
    return new Promise(function(resolve, reject) {
        var stream = byline(fs.createReadStream(objFile, {encoding: 'utf8'}));
        stream.on('data', function (line) {
            if (!defined(mtlPath)) {
                var mtllibMatches = line.match(/^mtllib.*/gm);
                if (mtllibMatches !== null) {
                    var mtlFile = mtllibMatches[0].substring(7).trim();
                    mtlPath = mtlFile;
                    if (!path.isAbsolute(mtlPath)) {
                        mtlPath = path.join(inputPath, mtlFile);
                    }
                }
            }
            if (!hasMaterialGroups) {
                hasMaterialGroups = /^usemtl/gm.test(line);
            }
            if (!hasPositions) {
                hasPositions = /^v\s/gm.test(line);
            }
            if (!hasNormals) {
                hasNormals = /^vn/gm.test(line);
            }
            if (!hasUVs) {
                hasUVs = /^vt/gm.test(line);
            }
        });

        stream.on('error', function(err) {
            reject(err);
        });

        stream.on('end', function () {
            if (!hasPositions) {
                reject(new Error('Could not process OBJ file, no positions.'));
            }
            info = {
                hasNormals: hasNormals,
                hasUVs: hasUVs
            };
            resolve();
        });
    })
        .then(function() {
            return getMaterials(mtlPath, hasMaterialGroups);
        })
        .then(function(returnedMaterials) {
            materials = returnedMaterials;
            return getImages(inputPath, materials);
        })
        .then(function(images) {
            return {
                info : info,
                materials : materials,
                images : images
            };
        });
}
