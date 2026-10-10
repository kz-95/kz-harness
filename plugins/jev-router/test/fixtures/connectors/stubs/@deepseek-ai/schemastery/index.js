// A stand-in for schemastery, enough for the connectors to build their Config schema as they load;
// these tests never validate a config with it.
const schema = () => {
  const s = (value) => value
  s.min = () => schema()
  s.default = () => schema()
  return s
}
export default { object: schema, string: schema, dict: schema, union: schema, number: schema }
