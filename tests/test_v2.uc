'use strict';
import { readfile } from 'fs';
import { generate } from '../luci-app-mosdns/root/usr/share/mosdns/v2-config.uc';
import { migrate, serialize } from '../luci-app-mosdns/root/usr/share/mosdns/v2-migrate.uc';
let input = json(readfile(ARGV[1]));
if (ARGV[0] == 'generate') print(sprintf('%J\n', generate(input.sections, input.default_dns || [])));
else if (ARGV[0] == 'migrate') print(sprintf('%J\n', migrate(input.sections, input.legacy)));
else if (ARGV[0] == 'serialize') print(serialize(input.sections));
else die('Unknown test mode');
