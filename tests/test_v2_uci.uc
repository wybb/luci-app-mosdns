'use strict';
import { cursor } from 'uci';
let c = cursor(ARGV[0], ARGV[0] + '/delta', '');
if (!c || !c.load('mosdns')) die('Unable to load isolated UCI fixture');
let sections = [];
c.foreach('mosdns', null, s => push(sections, s));
print(sprintf('%J\n', sections));
