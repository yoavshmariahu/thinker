package main
import("fmt";"regexp";"strings";"encoding/json";"os")
var _ = strings.Split
const placeholderInstanceNamePrefix = "i-placeholder-"
type AwsInstanceRef struct{ProviderID,Name string}
var validAwsRefIdRegex = regexp.MustCompile(fmt.Sprintf(`^aws\:\/\/\/[-0-9a-z]*\/[-0-9a-z]*(\/[-0-9a-z\.]*)?$|aws\:\/\/\/[-0-9a-z]*\/%s.*$`, placeholderInstanceNamePrefix))
func AwsRefFromProviderId(id string) (*AwsInstanceRef, error) {
	if validAwsRefIdRegex.FindStringSubmatch(id) == nil {
		return nil, fmt.Errorf("wrong id: expected format aws:///<zone>/<name>, got %v", id)
	}
	splitted := strings.Split(id[7:], "/")
	return &AwsInstanceRef{
		ProviderID: id,
		Name:       splitted[1],
	}, nil
}
func main(){
 id:="aws:///us-east-1a/i-placeholder-some/arbitrary/cluster/local"
 ref,err:=AwsRefFromProviderId(id)
 _,bad:=AwsRefFromProviderId("junkaws:///us-east-1a/i-placeholder-some")
 json.NewEncoder(os.Stdout).Encode(map[string]bool{"slashPreserved":err==nil && ref.Name=="i-placeholder-some/arbitrary/cluster/local","malformedRejected":bad!=nil,"providerIDPreserved":err==nil && ref.ProviderID==id})
}
