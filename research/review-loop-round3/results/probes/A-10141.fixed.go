package main
import("fmt";"encoding/json";"os")
func replicas(desired,ready int)(int,error){
 ds:=struct{Status struct{DesiredNumberScheduled,NumberReady int}}{}
 ds.Status.DesiredNumberScheduled=desired;ds.Status.NumberReady=ready
 creator:=struct{Namespace,Name string}{"test","ds"}
		if ds.Status.DesiredNumberScheduled == 0 {
			return 0, fmt.Errorf("daemon set %s/%s has no desired scheduled pods", creator.Namespace, creator.Name)
		}
		return int(ds.Status.DesiredNumberScheduled), nil
}
func main(){a,e:=replicas(5,0);b,f:=replicas(5,2);json.NewEncoder(os.Stdout).Encode(map[string]bool{"zeroReadyReturnsDesired":e==nil&&a==5,"partialReadyReturnsDesired":f==nil&&b==5})}
