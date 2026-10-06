import fs from 'node:fs';
const ref = Ref => ({ Ref });
const sub = value => ({ 'Fn::Sub': value });
const arn = name => ({ 'Fn::GetAtt': [name, 'Arn'] });

export function template() {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Thinker hosted Jev: anonymous enrollment, revocable tokens and atomic request quotas',
    Parameters: { SecretArn: { Type: 'String' } },
    Resources: {
      Quotas: { Type: 'AWS::DynamoDB::Table', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
        BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        SSESpecification: { SSEEnabled: true },
      } },
      Logs: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: sub('/aws/lambda/${AWS::StackName}'), RetentionInDays: 14 } },
      Role: { Type: 'AWS::IAM::Role', Properties: {
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
        Policies: [{ PolicyName: 'proxy-only', PolicyDocument: { Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: arn('Logs') },
          { Effect: 'Allow', Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'], Resource: arn('Quotas') },
          { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('SecretArn') },
        ] } }],
      } },
      Function: { Type: 'AWS::Lambda::Function', DependsOn: 'Logs', Properties: {
        FunctionName: ref('AWS::StackName'), Runtime: 'nodejs22.x', Architectures: ['arm64'], Handler: 'index.handler',
        Role: arn('Role'), MemorySize: 512, Timeout: 8, ReservedConcurrentExecutions: 5,
        Environment: { Variables: { SECRET_ARN: ref('SecretArn'), TABLE_NAME: ref('Quotas') } },
        Code: { ZipFile: fs.readFileSync(new URL('./handler.cjs', import.meta.url), 'utf8') },
      } },
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: ref('AWS::StackName'), ProtocolType: 'HTTP' } },
      Integration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: {
        ApiId: ref('Api'), IntegrationType: 'AWS_PROXY', IntegrationUri: arn('Function'), PayloadFormatVersion: '2.0', TimeoutInMillis: 10000,
      } },
      ...Object.fromEntries([['Health', 'GET /health'], ['Enroll', 'POST /v1/enroll'], ['Evaluate', 'POST /v1/systemone']].map(([name, route]) =>
        [name, { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: ref('Api'), RouteKey: route, Target: sub('integrations/${Integration}') } }])),
      Stage: { Type: 'AWS::ApiGatewayV2::Stage', Properties: { ApiId: ref('Api'), StageName: '$default', AutoDeploy: true,
        DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 } } },
      Invoke: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('Function'), Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com', SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*') } },
      Errors: { Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmDescription: 'Inspect Jev proxy when Lambda errors recur',
        Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: ref('Function') }],
        Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: 5, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' } },
    },
    Outputs: { Endpoint: { Value: sub('https://${Api}.execute-api.${AWS::Region}.amazonaws.com/v1/systemone') },
      Table: { Value: ref('Quotas') }, Function: { Value: ref('Function') } },
  };
}
