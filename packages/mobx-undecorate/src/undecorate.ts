import {
    API,
    FileInfo,
    Decorator,
    ASTPath,
    ClassProperty,
    Node,
    ClassDeclaration,
    ClassMethod,
    ObjectExpression
} from "jscodeshift"

const validPackages = ["mobx", "mobx-react", "mobx-react-lite"]
const validDecorators = ["action", "observable", "computed", "observer", "inject"]

const babylon = require("@babel/parser")

const defaultOptions = {
    sourceType: "module",
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    startLine: 1,
    tokens: true,
    plugins: [
        // "estree",
        ["decorators", { decoratorsBeforeExport: true }],
        "asyncGenerators",
        "bigInt",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "legacy-decorators",
        "doExpressions",
        "dynamicImport",
        "exportDefaultFrom",
        "exportNamespaceFrom",
        "functionBind",
        "functionSent",
        "importMeta",
        "logicalAssignment",
        "nullishCoalescingOperator",
        "numericSeparator",
        "objectRestSpread",
        "optionalCatchBinding",
        "optionalChaining",
        ["pipelineOperator", { proposal: "minimal" }],
        "throwExpressions",
        "typescript"
    ]
}

export const parser = {
    parse(code) {
        // @ts-ignore
        defaultOptions.plugins[0][1].decoratorsBeforeExport = !!decoratorsBeforeExport
        return babylon.parse(code, defaultOptions)
    }
}

let decoratorsBeforeExport = true // hack to get the options into the parser

export default function tranform(
    fileInfo: FileInfo,
    api: API,
    options?: { ignoreImports?: boolean; keepDecorators?: boolean; decoratorsAfterExport?: boolean }
): any {
    decoratorsBeforeExport = !options?.decoratorsAfterExport
    const j = api.jscodeshift
    const superCall = j.expressionStatement(j.callExpression(j.super(), []))
    superCall.comments = [
        j.commentLine(
            " TODO: [mobx-undecorate] verify the constructor arguments and the arguments of this automatically generated super call"
        )
    ]
    const reactSuperCall = j.expressionStatement(
        j.callExpression(j.super(), [j.identifier("props")])
    )
    const source = j(fileInfo.source)
    const lines = fileInfo.source.split("\n")
    let changed = false
    let needsInitializeImport = false
    const decoratorsUsed = new Set<String>(options?.ignoreImports ? validDecorators : [])
    let usesDecorate = options?.ignoreImports ? true : false
    let hasReact = options?.ignoreImports ? true : false

    source.find(j.ImportDeclaration).forEach(im => {
        if (im.value.source.value === "react") hasReact = true
        if (validPackages.includes(im.value.source.value as string)) {
            let decorateIndex = -1
            im.value.specifiers.forEach((specifier, idx) => {
                // imported decorator
                if (
                    j.ImportSpecifier.check(specifier) &&
                    validDecorators.includes(specifier.imported.name)
                ) {
                    decoratorsUsed.add(specifier.imported.name)
                }
                // imported decorate call
                if (j.ImportSpecifier.check(specifier) && specifier.imported.name === "decorate") {
                    usesDecorate = true
                    decorateIndex = idx
                }
            })
            if (decorateIndex !== -1) {
                im.value.specifiers.splice(decorateIndex, 1)
            }
        }
    })

    // rewrite all decorate calls to class decorators
    if (usesDecorate) {
        source
            .find(j.CallExpression)
            .filter(
                callPath =>
                    j.Identifier.check(callPath.value.callee) &&
                    callPath.value.callee.name === "decorate"
            )
            .forEach(callPath => {
                let canRemoveDecorateCall = true
                if (callPath.value.arguments.length !== 2) {
                    warn("Expected a decorate call with two arguments", callPath.value)
                    return
                }
                const target = callPath.value.arguments[0]
                const decorators = callPath.value.arguments[1]

                if (!j.Identifier.check(target)) {
                    // not targetting a class, just swap it with makeObservable
                    changed = true
                    // @ts-ignore // TODO: or "observable" ?
                    callPath.value.callee.name = "makeObservable"
                    return
                }
                const declarations = callPath.scope.getBindings()[target.name]
                if (declarations.length === 0) {
                    warn(
                        `Expected exactly one class declaration for '${target.name}' but found ${declarations.length}`,
                        target
                    )
                    return
                }
                const targetDeclaration = declarations[0].parentPath.value
                if (!j.ClassDeclaration.check(targetDeclaration)) {
                    // not targetting a class, just swap it with makeObservable
                    changed = true
                    // @ts-ignore // TODO: or "observable" ?
                    callPath.value.callee.name = "makeObservable"
                    return
                }
                const clazz: ClassDeclaration = targetDeclaration
                // @ts-ignore
                createConstructor(clazz, decorators, [])

                // Remove the callPath (and wrapping expressionStatement)
                if (canRemoveDecorateCall) {
                    callPath.parent.prune()
                }
                changed = true
            })
    }

    // rewrite all class proprty decorators
    source.find(j.ClassDeclaration).forEach(clazzPath => {
        const clazz = clazzPath.value
        const effects = {
            membersMap: [] as any
        }

        clazz.body.body = clazz.body.body.map(prop => {
            if (j.ClassProperty.check(prop) || j.ClassMethod.check(prop)) {
                return handleProperty(prop as any, effects, clazzPath)
            }
            return prop
        })

        if (effects.membersMap.length) {
            changed = true
            let privates: string[] = []
            const members = j.objectExpression(
                effects.membersMap.map(([key, value, computed, isPrivate]) => {
                    // loose the comments, as they are already in the field definition
                    const { comments, ...k } = key
                    const { comments: comments2, ...v } = value
                    const prop = j.objectProperty(k, v)
                    prop.computed = !!computed
                    if (isPrivate) privates.push(k.name)
                    return prop
                })
            )
            createConstructor(clazz, members, privates)
            needsInitializeImport = true
        }

        // rewrite all @observer / @inject
        if (!options?.keepDecorators && decoratorsUsed.has("observer")) {
            handleObserverAndInject(clazzPath)
        }
    })

    if (needsInitializeImport && !options?.ignoreImports) {
        // @ts-ignore
        const mobxImport = source
            .find(j.ImportDeclaration)
            .filter(im => im.value.source.value === "mobx")
            .nodes()
            .filter(node => node.importKind === "value")[0]
        if (!mobxImport) {
            console.warn(
                "Failed to find mobx import, can't add makeObservable as dependency in " +
                    fileInfo.path
            )
        } else {
            if (!mobxImport.specifiers) {
                mobxImport.specifiers = []
            }
            mobxImport.specifiers.push(j.importSpecifier(j.identifier("makeObservable")))
        }
    }
    if (!decoratorsUsed.size && !usesDecorate) {
        return // no mobx in this file
    }
    if (changed) {
        return source.toSource()
    }

    function handleObserverAndInject(clazzPath: ASTPath<ClassDeclaration>) {
        const clazz = clazzPath.value
        // find @observer
        const observerDecorator = (clazz as any).decorators?.find(
            dec =>
                j.Decorator.check(dec) &&
                j.Identifier.check(dec.expression) &&
                dec.expression.name === "observer"
        )
        // find @inject
        const injectDecorator = (clazz as any).decorators?.find(
            dec =>
                j.Decorator.check(dec) &&
                j.CallExpression.check(dec.expression) &&
                j.Identifier.check(dec.expression.callee) &&
                dec.expression.callee.name === "inject"
        )
        if (!observerDecorator && !injectDecorator) return

        // re-create the class
        let newClassDefExpr: any = j.classExpression(clazz.id, clazz.body, clazz.superClass)
        newClassDefExpr.superTypeParameters = clazz.superTypeParameters
        newClassDefExpr.typeParameters = clazz.typeParameters
        newClassDefExpr.implements = clazz.implements
        // wrap with observer
        if (observerDecorator)
            newClassDefExpr = j.callExpression(j.identifier("observer"), [newClassDefExpr])
        // wrap with inject
        if (injectDecorator)
            newClassDefExpr = j.callExpression(injectDecorator.expression, [newClassDefExpr])

        changed = true
        const decl = j.variableDeclaration("const", [
            j.variableDeclarator(j.identifier(clazz.id!.name), newClassDefExpr)
        ])
        decl.comments = clazz.comments
        clazzPath.replace(decl)
    }

    function handleProperty(
        property: ClassProperty & /* | or ClassMethod */ {
            decorators: Decorator[]
            accessibility: "private" | "protected" | "public"
        },
        effects: {
            membersMap: [[any, any, boolean, boolean]]
        },
        clazzPath: ASTPath<ClassDeclaration>
    ): ClassProperty | ClassMethod {
        const decorators = property.decorators
        if (!decorators || decorators.length === 0) {
            return property
        }
        if (decorators.length > 1) {
            warn("Found multiple decorators, skipping..", property.decorators[0])
            return property
        }
        const decorator = decorators[0]
        if (!j.Decorator.check(decorator)) {
            return property
        }
        const expr = decorator.expression
        if (j.Identifier.check(expr) && !decoratorsUsed.has(expr.name)) {
            warn(`Found non-mobx decorator @${expr.name}`, decorator)
            return property
        }
        if (property.static) {
            warn(`Static properties are not supported ${property.key.loc?.source}`, property)
            return property
        }

        if (options?.keepDecorators !== true) property.decorators.splice(0)

        effects.membersMap.push([
            property.key,
            expr,
            property.computed,
            property.accessibility === "private" || property.accessibility === "protected"
        ])
        return property
    }

    function createConstructor(
        clazz: ClassDeclaration,
        members: ObjectExpression,
        privates: string[]
    ) {
        // makeObservable(this, { members })
        const initializeObservablesCall = j.expressionStatement(
            j.callExpression(
                j.identifier("makeObservable"),
                options?.keepDecorators ? [j.thisExpression()] : [j.thisExpression(), members]
            )
        )
        if (privates.length) {
            // @ts-ignore
            initializeObservablesCall.expression.typeArguments = j.tsTypeParameterInstantiation([
                j.tsTypeReference(j.identifier(clazz.id!.name)),
                j.tsUnionType(
                    // @ts-ignore
                    privates.map(member => j.tsLiteralType(j.stringLiteral(member)))
                )
            ])
        }

        const needsSuper = !!clazz.superClass
        let constructorIndex = clazz.body.body.findIndex(
            member => j.ClassMethod.check(member) && member.kind === "constructor"
        )

        // create a constructor
        if (constructorIndex === -1) {
            if (needsSuper) {
                warn(
                    `Generated new constructor for class ${clazz.id?.name}. But since the class does have a base class, it might be needed to revisit the arguments that are passed to \`super()\``,
                    clazz
                )
            }

            let superClassName = j.Identifier.check(clazz.superClass)
                ? clazz.superClass.name
                : j.MemberExpression.check(clazz.superClass)
                ? j.Identifier.check(clazz.superClass.property)
                    ? clazz.superClass.property.name
                    : ""
                : ""

            // if this clazz is a react component, we now that the constructor and super call have one argument, the props
            let isReactComponent =
                hasReact && ["Component", "PureComponent"].includes(superClassName)
            let propsType = isReactComponent && clazz.superTypeParameters?.params[0]
            const propsParam = j.identifier("props")
            // reuse the generic if we found it
            if (propsType) propsParam.typeAnnotation = j.tsTypeAnnotation(propsType as any)
            // create the constructor
            const constructorDecl = j.methodDefinition(
                "constructor",
                j.identifier("constructor"),
                j.functionExpression(
                    null,
                    isReactComponent ? [propsParam] : [],
                    j.blockStatement(
                        needsSuper
                            ? [
                                  isReactComponent ? reactSuperCall : superCall,
                                  initializeObservablesCall
                              ]
                            : [initializeObservablesCall]
                    )
                )
            )

            const firstMethodIndex = clazz.body.body.findIndex(member =>
                j.ClassMethod.check(member)
            )
            if (firstMethodIndex === -1) {
                clazz.body.body.push(constructorDecl)
            } else {
                clazz.body.body.splice(firstMethodIndex, 0, constructorDecl)
            }
        } else {
            const c: ClassMethod = clazz.body.body[constructorIndex] as any
            j.ClassMethod.assert(c)
            const firstStatement = c.body.body[0]
            const hasSuper =
                firstStatement &&
                j.ExpressionStatement.check(firstStatement) &&
                j.CallExpression.check(firstStatement.expression) &&
                j.Super.check(firstStatement.expression.callee)
            c.body.body.splice(hasSuper ? 1 : 0, 0, initializeObservablesCall)
        }
    }

    function warn(msg: string, node: Node) {
        const line = lines[node.loc!.start.line - 1]
        const shortline = line.replace(/^\s*/, "")
        console.warn(
            `[mobx:undecorate] ${msg} at (${fileInfo.path}:${node.loc!.start.line}:${
                node.loc!.start.column
            }):\n\t${shortline}\n\t${"^".padStart(
                node.loc!.start.column + 1 - line.indexOf(shortline),
                " "
            )}\n`
        )
    }
}
