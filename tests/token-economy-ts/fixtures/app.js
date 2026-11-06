const util = require('./lib/util');
const library = require('./lib');
import {Button} from './components/Button';
import {typed} from './typed';
import './setup';
export * from './lib/util';
export const load = () => import('./lazy');
const optional = require('./missing');
const express = require('express');
function router() {
    return util.sum(library.value, typed);
}
module.exports = {router, load};
