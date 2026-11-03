#!/bin/bash
case "$build_env" in
    prod)
        echo "Setting prod environment"
        app_name="embodied-brain-prod"
        ;;
    pre)
        echo "Setting staging environment"
        app_name="embodied-brain-staging"
        ;;
    test)
        echo "Setting test environment"
        app_name="embodied-brain-test"
        ;;
    dev)
        echo "Setting dev environment"
        app_name="embodied-brain-dev"
        ;;
    *)
        echo "Error: Invalid build_env '$build_env'. Must be one of: prod, pre, test, dev"
        usage
        ;;
esac
git clone gitlab@git.narwel.com:devops/devops_script.git
cd embodied-brain
make gen-octopus-docker
make docker-image
COMMIT_ID=$(git rev-parse HEAD)
#推送镜像
docker push harbor.devops.narwal.com/embodied-ai/embodied-brain:${COMMIT_ID}_${BUILD_ID}
echo y| argocd login 10.8.150.166:30882  --grpc-web --username admin --password  ${argo}   --insecure
branch_name="${branch#origin/}"
# env_name="${env_file#env.}"
if [ "$build_env" == "pre" ]; then
    env_name="stage"
elif [ "$build_env" == "prod" ]; then
    env_name="prod"
elif [ "$build_env" == "test" ]; then
    env_name="test"
elif [ "$build_env" == "dev" ]; then
    env_name="dev"
fi
argocd app set ${app_name} --revision ${branch_name}
argocd app set ${app_name} -p app.env=${env_name}
argocd app set ${app_name} -p app.image=harbor.devops.narwal.com/embodied-ai/embodied-brain:${COMMIT_ID}_${BUILD_ID}


if [ $? -ne 0 ]; then
    echo "set embodied-brain argocd  image  failed ---"
    exit 1;
fi
argocd app sync ${app_name}
if [ $? -ne 0 ]; then
    echo "sync embodied-brain argocd failed ---" 
    exit 1;
fi
cd $WORKSPACE/devops_script/tools && python3 build_single_chat.py ${BUILD_USER_ID} "发布通知：${app_name} 部署环境成功"
