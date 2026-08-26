import { readFile } from "node:fs/promises";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

const document = YAML.parse(await readFile("api/Life-家庭生活工作台-OpenAPI-v0.1.yaml", "utf8"));
await SwaggerParser.validate(document);
console.log(`openapi valid: ${document.openapi}; paths=${Object.keys(document.paths).length}; schemas=${Object.keys(document.components.schemas).length}`);
