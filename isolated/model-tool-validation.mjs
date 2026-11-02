// Validate model-authored arguments against the exact advertised native schema.
// This returns actionable protocol errors; it never fills or rewrites inputs.
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';

export function createModelToolArgumentValidator(definitions){
  const provider=new AjvJsonSchemaValidator();
  const validators=new Map(definitions.map(tool=>[tool.name,provider.getValidator(tool.inputSchema)]));
  const schemas=new Map(definitions.map(tool=>[tool.name,structuredClone(tool.inputSchema)]));
  return (name,args)=>{
    const validate=validators.get(name);
    if(!validate)throw new TypeError('Unknown declared model tool');
    const checked=validate(args);
    return checked.valid?null:{isError:true,structuredContent:{code:'MODEL_TOOL_ARGUMENTS',backendCalled:false,expectedSchema:structuredClone(schemas.get(name))},
      content:[{type:'text',text:`Arguments do not match the advertised ${name} schema. No MCP call ran and no input was changed. ${String(checked.errorMessage).slice(0,6000)}`} ]};
  };
}
