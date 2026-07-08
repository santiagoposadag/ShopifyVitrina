import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, resolveDataPath } from "./config.js";
import { openDb, type DB } from "./db.js";
import { publicPathFor } from "./media.js";
import { parseListing } from "./parse-listing.js";
import { insertPhoto, upsertProduct } from "./repo.js";
import type { ProductAttributes } from "./types.js";

// Repo root is two levels up from server/src.
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../");

interface SeedConfig {
  dbPath: string;
  mediaDir: string;
  publicBaseUrl: string;
}

function seedConfig(): SeedConfig {
  return {
    dbPath: resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db"),
    mediaDir: resolveDataPath(process.env["MEDIA_DIR"]?.trim() || "./data/media"),
    publicBaseUrl: (process.env["PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001").replace(
      /\/+$/,
      "",
    ),
  };
}

interface SeedProperty {
  folder: string;
  title: string;
  description: string;
  attributes: ProductAttributes;
}

const PROPERTIES: SeedProperty[] = [
  {
    folder: "propiedad_1",
    title: "Casa para estrenar en Rionegro (Barro Blanco)",
    description:
      "Casa nueva de 3 niveles en Rionegro, sector Barro Blanco. Muy fresca e iluminada, con piso porcelánico, cocina moderna, jardín, zona de ropas, sala de TV con balcón y salón de entretenimiento con terraza. Red de gas natural y parqueadero de visitantes. Sin administración. Cerca de restaurantes, supermercados y gimnasios, a 7 minutos de Jardines de Llanogrande.",
    attributes: {
      neighborhood: "Barro Blanco",
      city: "Rionegro",
      bedrooms: 4,
      bathrooms: 6,
      levels: 3,
      admin_fee: 0,
      features: [
        "Piso porcelánico mate",
        "Cocina moderna",
        "Jardín",
        "Zona de ropas",
        "Sala de TV con balcón",
        "Salón de entretenimiento con terraza",
        "Red de gas natural",
        "Estacionamiento privado",
        "Parqueadero de visitantes",
        "Zona de juegos infantiles",
      ],
    },
  },
  {
    folder: "propiedad_2",
    title: "Apartamento en Belén Rosales (Malibú)",
    description:
      "Apartamento en el barrio Belén Rosales, sector Malibú, en un octavo piso con ascensor. 3 alcobas con clóset, 2 baños con cabina en vidrio templado, cocina semi-integral abierta con península y red de gas, zona de ropa con calentador de paso, sala-comedor, balcón grande y parqueadero. Edificio con videoportero, cerca del Parque de Belén Malibú, la Unidad Deportiva de Belén, la UPB y el C.C. Unicentro.",
    attributes: {
      neighborhood: "Belén Rosales",
      city: "Medellín",
      bedrooms: 3,
      bathrooms: 2,
      floor: 8,
      elevator: true,
      admin_fee: 270000,
      estrato: 5,
      negotiable: true,
      features: [
        "Ascensor",
        "Videoportero",
        "Cocina semi-integral con península",
        "Red de gas",
        "Zona de ropa con calentador de paso",
        "Balcón grande",
        "Parqueadero",
        "Baños con cabina en vidrio templado",
      ],
    },
  },
];

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function readMessages(folder: string): string[] {
  const dir = join(REPO_ROOT, folder, "mensajes_de_texto");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

function copyPhotos(config: SeedConfig, folder: string, code: string): string[] {
  const dir = join(REPO_ROOT, folder, "fotos");
  mkdirSync(config.mediaDir, { recursive: true });
  const files = readdirSync(dir)
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .sort();
  const fileNames: string[] = [];
  files.forEach((f, index) => {
    const ext = extname(f).toLowerCase() === ".jpeg" ? ".jpg" : extname(f).toLowerCase();
    const fileName = `seed-${code}-${index + 1}${ext}`;
    copyFileSync(join(dir, f), join(config.mediaDir, fileName));
    fileNames.push(fileName);
  });
  return fileNames;
}

function seedOne(db: DB, config: SeedConfig, property: SeedProperty): void {
  const messages = readMessages(property.folder);
  const parsed = parseListing(messages);

  if (!parsed.code) throw new Error(`Could not parse a code for ${property.folder}`);
  if (!parsed.price) throw new Error(`Could not parse a price for ${property.folder}`);

  const attributes: ProductAttributes = { ...property.attributes };
  if (parsed.area_m2 !== undefined) attributes.area_m2 = parsed.area_m2;

  const { product } = upsertProduct(
    db,
    {
      code: parsed.code,
      title: property.title,
      description: property.description,
      price: parsed.price,
      currency: "COP",
      status: "active",
      attributes,
    },
    null,
  );

  const fileNames = copyPhotos(config, property.folder, parsed.code);
  fileNames.forEach((fileName, index) => {
    insertPhoto(db, {
      product_id: product.id,
      file_path: join(config.mediaDir, fileName),
      public_path: publicPathFor(config, fileName),
      caption: index === 0 ? property.title : null,
      sort: index,
    });
  });

  console.log(
    `Seeded ${property.folder}: code=${parsed.code} price=${parsed.price} area_m2=${parsed.area_m2 ?? "?"} photos=${fileNames.length}`,
  );
}

function main(): void {
  loadDotEnv();
  const config = seedConfig();
  const db = openDb(config.dbPath);

  // Reset seeded rows so re-running is idempotent.
  db.exec(`DELETE FROM product_photos; DELETE FROM product_changes; DELETE FROM products;`);

  for (const property of PROPERTIES) {
    seedOne(db, config, property);
  }

  const count = (db.prepare(`SELECT COUNT(*) AS n FROM products`).get() as { n: number }).n;
  const photoCount = (db.prepare(`SELECT COUNT(*) AS n FROM product_photos`).get() as { n: number }).n;
  console.log(`Done. products=${count} photos=${photoCount} db=${config.dbPath}`);
  db.close();
}

main();
