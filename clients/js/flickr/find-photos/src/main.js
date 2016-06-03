// @flow

// Copyright 2016 The Noms Authors. All rights reserved.
// Licensed under the Apache License, version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0

import argv from 'yargs';
import {
  DatasetSpec,
  getTypeOfValue,
  isSubtype,
  makeStructType,
  makeUnionType,
  Map,
  newStruct,
  numberType,
  Set,
  stringType,
  Struct,
  walk,
} from '@attic/noms';

const args = argv
  .usage(
    'Indexes Photo objects out of slurped Flickr metadata\n\n' +
    'Usage: flickr-find-photos <in-object> <out-dataset>')
  .demand(2)
  .argv;

const sizes = ['t', 's', 'm', 'l', 'o'];
const flickrNum = makeUnionType([stringType, numberType]);
const sizeTypes = sizes.map(s =>
  makeStructType('', {
    ['url_' + s]: stringType,
    ['width_' + s]: flickrNum,
    ['height_' + s]: flickrNum,
  }));

// This is effectively:
// union {
//   struct {
//     title: string,
//     tags: string,
//     latitude: flickrNum,
//     longitude: flickrNum,
//     url_t: string,
//     width_t: flickrNum,
//     height_t: flickrNum,
//   } |
//   ... for all the image size suffixes ...
// }
const imageType = makeUnionType(sizeTypes.map(st =>
    makeStructType('', Object.assign(({
      title: stringType,
      tags: stringType,
      latitude: flickrNum,
      longitude: flickrNum,
    }:Object), st.desc.fields))));

main().catch(ex => {
  console.error(ex);
  process.exit(1);
});

async function main(): Promise<void> {
  const inSpec = DatasetSpec.parse(args._[0]);
  const outSpec = DatasetSpec.parse(args._[1]);
  if (!inSpec) {
    throw 'invalid input object spec';
  }
  if (!outSpec) {
    throw 'inalid output dataset spec';
  }

  const input = await inSpec.value();
  const output = outSpec.dataset();
  let result = Promise.resolve(new Set());

  // TODO: How to report progress?
  await walk(input, inSpec.database.database(), (v: any) => {
    if (isSubtype(imageType, getTypeOfValue(v))) {
      const photo: Object = {
        title: v.title,
        tags: new Set(v.tags ? v.tags.split(' ') : []),
        sizes: getSizes(v),
      };

      // Flickr API always includes a geoposition, but sometimes it is zero.
      const geo = (getGeo(v):Object);
      if (geo.latitude !== 0 && geo.longitude !== 0) {
        photo.geoposition = geo;
      }

      result = result.then(r => r.insert(newStruct('Photo', photo)));
      return true;
    }
    return false;
  });

  return output.commit(await result).then();
}

function getGeo(input: Object): Struct {
  return newStruct('Geoposition', {
    latitude: Number(input.latitude),
    longitude: Number(input.longitude),
  });
}

function getSizes(input: Object): Map<Struct, string> {
  return new Map(
    sizes.map((s, i) => {
      if (!isSubtype(sizeTypes[i], input.type)) {
        // $FlowIssue - Flow doesn't realize that filter will return only non-nulls.
        return null;
      }
      const url = input['url_' + s];
      const width = Number(input['width_' + s]);
      const height = Number(input['height_' + s]);
      return [newStruct('', {width, height}), url];
    }).filter(kv => kv));
}
