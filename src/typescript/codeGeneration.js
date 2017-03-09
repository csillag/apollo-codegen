import {
  GraphQLError,
  getNamedType,
  isCompositeType,
  isAbstractType,
  isEqualType,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
  GraphQLInputObjectType
} from 'graphql'

import  { isTypeProperSuperTypeOf } from '../utilities/graphql';

import { camelCase, pascalCase } from 'change-case';
import Inflector from 'inflected';
const uniqWith = require("lodash.uniqwith");

import {
  join,
  wrap,
} from '../utilities/printing';

import CodeGenerator from '../utilities/CodeGenerator';

import {
  interfaceDeclaration,
  propertyDeclaration,
} from './language';

import {
  typeNameFromGraphQLType,
} from './types';

export function generateSource(context) {
  const generator = new CodeGenerator(context);

  generator.printOnNewline('//  This file was automatically generated and should not be edited.');
  generator.printOnNewline('/* tslint:disable */');
  generator.printOnNewline('import gql from "graphql-tag";');
  generator.printOnNewline('import { registerQuery, registerMutation } from "../../lib/client/apollo-stuff";');
    
  typeDeclarationForGraphQLType(context.typesUsed.forEach(type =>
    typeDeclarationForGraphQLType(generator, type)
  ));
    Object.values(context.operations).forEach(operation => {
    const opName = operation.operationName;
    const hasVariables = interfaceVariablesDeclarationForOperation(generator, operation);
    interfaceDeclarationForOperation(generator, operation);
    generator.printNewline();
    const docName = `${opName}Document`;
    const fragments = operation.fragmentsReferenced.map(name => context.fragments[name].source).join('\n');
    generator.printOnNewline(`const ${docName} = gql\`${fragments} ${operation.source}\`;`);
    const ifName = interfaceNameFromOperation(operation);    
    generator.printNewline();
    const variablesIfName = hasVariables ? ifName + "Variables" : "{}";
    const register = (operation.operationType === 'mutation') ? 'registerMutation' : 'registerQuery'
    generator.printOnNewline(`export const ${opName} = ${register}<${variablesIfName}, ${ifName}>(${docName});`);
  })
  Object.values(context.fragments).forEach(operation =>
    interfaceDeclarationForFragment(generator, operation)
  );

  generator.printOnNewline('/* tslint:enable */');
  generator.printNewline();

  return generator.output;
}

export function typeDeclarationForGraphQLType(generator, type) {
  if (type instanceof GraphQLEnumType) {
    enumerationDeclaration(generator, type);
  } else if (type instanceof GraphQLInputObjectType) {
    structDeclarationForInputObjectType(generator, type);
  }
}

function enumerationDeclaration(generator, type) {
  const { name, description } = type;
  const values = type.getValues();

  generator.printNewlineIfNeeded();
  generator.printOnNewline(description && `// ${description}`);
  generator.printOnNewline(`export type ${name} =`);
  const nValues = values.length;
  values.forEach((value, i) => 
    generator.printOnNewline(`  "${value.value}"${i === nValues-1 ? ';' : ' |'}${wrap(' // ', value.description)}`)
  );
  generator.printNewline();
}

function structDeclarationForInputObjectType(
  generator,
  type
  ) {
  const interfaceName = pascalCase(type.name);
  interfaceDeclaration(generator, {
    interfaceName,
  }, () => {
    const properties = propertiesFromFields(generator.context, Object.values(type.getFields()));
    propertyDeclarations(generator, properties, true);
  });
}

function interfaceNameFromOperation({operationName, operationType}) {
  switch (operationType) {
    case 'query':
      return `${pascalCase(operationName)}Query`;
      break;
    case 'mutation':
      return `${pascalCase(operationName)}Mutation`;
      break;
    case 'subscription':
      return `${pascalCase(operationName)}Subscription`;
      break;
    default:
      throw new GraphQLError(`Unsupported operation type "${operationType}"`);
  }
}

export function interfaceVariablesDeclarationForOperation(
  generator,
  {
    operationName,
    operationType,
    variables,
    fields,
    fragmentsReferenced,
    source,
  }
) {
  if (!variables || variables.length < 1) {
    return false;
  }
  const interfaceName = `${interfaceNameFromOperation({operationName, operationType})}Variables`;

  interfaceDeclaration(generator, {
    interfaceName,
  }, () => {
    const properties = propertiesFromFields(generator.context, variables);
    propertyDeclarations(generator, properties, true);
  });
  return true;
}

export function interfaceDeclarationForOperation(
  generator,
  {
    operationName,
    operationType,
    variables,
    fields,
    fragmentSpreads,
    fragmentsReferenced,
    source,
  }
) {
  const interfaceName = interfaceNameFromOperation({operationName, operationType});
  interfaceDeclaration(generator, {
    interfaceName,
    extendTypes: fragmentSpreads ? fragmentSpreads.map(f => `${pascalCase(f)}Fragment`) : null,
  }, () => {
    const properties = propertiesFromFields(generator.context, fields);
    propertyDeclarations(generator, properties, true);
  });
}

export function interfaceDeclarationForFragment(
  generator,
  {
    fragmentName,
    typeCondition,
    fields,
    inlineFragments,
    fragmentSpreads,
    source,
  }
) {
  const interfaceName = `${pascalCase(fragmentName)}Fragment`;

  interfaceDeclaration(generator, {
    interfaceName,
    extendTypes: fragmentSpreads ? fragmentSpreads.map(f => `${pascalCase(f)}Fragment`) : null,
  }, () => {
    const properties = uniqWith(propertiesFromFields(generator.context, fields)
    .concat(...(inlineFragments || []).map(fragment =>
      propertiesFromFields(generator.context, fragment.fields, true)
    )), (p1, p2) => {
      return (p1.fieldName === p2.fieldName) && (p1.typeName || p2.typeName);
    });

    propertyDeclarations(generator, properties, true);
  });
}

export function propertiesFromFields(context, fields, forceNullable) {
  return fields.map(field => propertyFromField(context, field, forceNullable));
}

export function propertyFromField(context, field, forceNullable) {
  let { name: fieldName, type: fieldType, description, fragmentSpreads, inlineFragments } = field;
  fieldName = fieldName || field.responseName;

  const propertyName = fieldName;

  let property = { fieldName, fieldType, propertyName, description };

  const namedType = getNamedType(fieldType);

  if (isCompositeType(namedType)) {
    const bareTypeName = pascalCase(Inflector.singularize(propertyName));
    const typeName = typeNameFromGraphQLType(context, fieldType, bareTypeName);
    let isArray = false;
    if (fieldType instanceof GraphQLList) {
      isArray = true;
    } else if (fieldType instanceof GraphQLNonNull && fieldType.ofType instanceof GraphQLList) {
      isArray = true
    }
    let isNullable = true;
    if (fieldType instanceof GraphQLNonNull && !forceNullable) {
      isNullable = false;
    }
    return {
      ...property,
      typeName, bareTypeName, fields: field.fields, isComposite: true, fragmentSpreads, inlineFragments, fieldType,
      isArray, isNullable,
    };
  } else {
    const typeName = typeNameFromGraphQLType(context, fieldType);
    return { ...property, typeName, isComposite: false, fieldType };
  }
}

export function propertyDeclarations(generator, properties, inInterface) {
  if (!properties) return;
  properties.forEach(property => {
    if (property.fields && property.fields.length > 0 || property.inlineFragments && property.inlineFragments.length > 0) {
      propertyDeclaration(generator, {...property, inInterface}, () => {
        const properties = propertiesFromFields(generator.context, property.fields)
        .concat(...(property.inlineFragments || []).map(fragment =>
          propertiesFromFields(generator.context, fragment.fields, true)
        ));
        propertyDeclarations(generator, properties);
      });
    } else {
      propertyDeclaration(generator, {...property, inInterface});
    }
  });
}
