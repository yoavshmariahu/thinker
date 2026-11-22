package main
import("fmt";"regexp";"encoding/json";"os")
const placeholderInstanceNamePrefix="i-placeholder-"
type AwsInstanceRef struct{ProviderID,Name string}
var validAwsRefIdRegex = regexp.MustCompile(fmt.Sprintf(`^aws\:\/\/\/[-0-9a-z]*\/(%s.*)$|^aws\:\/\/\/[-0-9a-z]*\/([-0-9a-z]*)(\/[-0-9a-z\.]*)?$`, placeholderInstanceNamePrefix))
func AwsRefFromProviderId(id string) (*AwsInstanceRef, error) {
	matches := validAwsRefIdRegex.FindStringSubmatch(id)
	if matches == nil || len(matches) != 4 {
		return nil, fmt.Errorf("wrong id: expected format aws:///<zone>/<name>, got %v", id)
	}

	var parsedName string
	if matches[1] != "" {
		parsedName = matches[1]
	} else {
		parsedName = matches[2]
	}

	return &AwsInstanceRef{
		ProviderID: id,
		Name:       parsedName,
	}, nil
}
func main(){
 id:="aws:///us-east-1a/i-placeholder-some/arbitrary/cluster/local"
 p,e:=AwsRefFromProviderId(id)
 _,bad:=AwsRefFromProviderId("junkaws:///us-east-1a/i-placeholder-some")
 ordinary,oe:=AwsRefFromProviderId("aws:///us-east-1a/i-12345")
 checks:=map[string]bool{"slashPreserved":e==nil&&p.Name=="i-placeholder-some/arbitrary/cluster/local","originalIDPreserved":e==nil&&p.ProviderID==id,"malformedRejected":bad!=nil,"ordinaryIDAccepted":oe==nil&&ordinary.Name=="i-12345"}
 json.NewEncoder(os.Stdout).Encode(checks)
}
