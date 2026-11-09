module Gtd.Hierarchy exposing
    ( breadcrumb
    , breadcrumbFor
    , compareByOrder
    , descendantIds
    , isDescendantOf
    , area
    , root
    , lineage
    , openChildren
    , separator
    , TypedPath(..)
    , typedPath
    , typedPathProblem
    )

{-| Reading the Project tree.

`parent_project_id` is authoritative, and a hand-edited vault can contain a cycle,
so every walk here carries the ids it has already seen and stops when one repeats.

-}

import Gtd.Data exposing (Project)
import Gtd.Id exposing (ProjectId)
import Gtd.ProjectStatus as ProjectStatus
import Set exposing (Set)


{-| What separates the levels of a breadcrumb, in pickers and in typed input alike.
-}
separator : String
separator =
    " > "


{-| The full `Root > Sub > Leaf` path of a Project.
-}
breadcrumb : List Project -> Project -> String
breadcrumb projects project =
    let
        walk seen current titles =
            if Set.member current.id seen then
                current.title :: titles

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> Gtd.Data.findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent (current.title :: titles)

                    Nothing ->
                        current.title :: titles
    in
    walk Set.empty project [] |> String.join separator


{-| The breadcrumb of a Project id, when that Project still exists.
-}
breadcrumbFor : List Project -> ProjectId -> Maybe String
breadcrumbFor projects projectId =
    Gtd.Data.findProject projectId projects |> Maybe.map (breadcrumb projects)


isDescendantOf : ProjectId -> List Project -> Project -> Bool
isDescendantOf rootId projects project =
    let
        walk seen maybeId =
            case maybeId of
                Nothing ->
                    False

                Just currentId ->
                    if currentId == rootId then
                        True

                    else if Set.member currentId seen then
                        False

                    else
                        case Gtd.Data.findProject currentId projects of
                            Just parent ->
                                walk (Set.insert currentId seen) parent.parentProjectId

                            Nothing ->
                                False
    in
    walk Set.empty project.parentProjectId


{-| A Project's top-level ancestor, or the Project itself when it has no parent.
-}
root : List Project -> Project -> Project
root projects project =
    let
        walk seen current =
            if Set.member current.id seen then
                current

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> Gtd.Data.findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent

                    Nothing ->
                        current
    in
    walk Set.empty project


{-| A Project's area: its top-level ancestor's, since only top-level Projects carry one.
-}
area : List Project -> Project -> Maybe String
area projects project =
    Gtd.Data.projectArea (root projects project)


{-| Every Project beneath one, at any depth.
-}
descendantIds : ProjectId -> List Project -> Set ProjectId
descendantIds rootId projects =
    projects
        |> List.filter (isDescendantOf rootId projects)
        |> List.map .id
        |> Set.fromList


{-| A Project and the Projects above it, the top-level one first.
-}
lineage : List Project -> Project -> List Project
lineage projects project =
    let
        walk seen current found =
            if Set.member current.id seen then
                found

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> Gtd.Data.findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent (parent :: found)

                    Nothing ->
                        found
    in
    walk Set.empty project [ project ]


{-| The sub-projects directly below a Project that aren't finished, in board order.
-}
openChildren : List Project -> Project -> List Project
openChildren projects project =
    projects
        |> List.filter
            (\candidate ->
                candidate.parentProjectId
                    == Just project.id
                    && candidate.id
                    /= project.id
                    && not (List.member (ProjectStatus.key candidate.status) [ "completed", "cancelled" ])
            )
        |> List.sortWith compareByOrder


{-| A typed Project name read as a path into the tree.

  - `Plain`: no separator, a name as it is.
  - `Under`: the part before the last separator names an existing Project, and the
    rest (possibly still empty) is the sub-project to create below it.
  - `NoParent`: the part before it names no Project, or several; the text says which.

Only the last segment is ever created, and a path that doesn't resolve is never
saved: neither an invented parent nor a Project titled "Heating > Heat pump" is what
someone typing it wanted. `parseProjectPath` in `src/domain/project-hierarchy.ts`
applies the same rule on the host.

-}
type TypedPath
    = Plain String
    | Under Project String
    | NoParent String


typedPath : String -> List Project -> TypedPath
typedPath query projects =
    let
        typed =
            String.trim query
    in
    case String.indexes ">" typed |> List.reverse |> List.head of
        Nothing ->
            Plain typed

        Just separatorIndex ->
            let
                prefix =
                    String.left separatorIndex typed |> String.trim

                leaf =
                    String.dropLeft (separatorIndex + 1) typed |> String.trim

                normalized =
                    String.toLower prefix

                byBreadcrumb =
                    List.filter (\project -> String.toLower (breadcrumb projects project) == normalized) projects

                byTitle =
                    List.filter (\project -> String.toLower project.title == normalized) projects
            in
            if String.isEmpty prefix then
                NoParent "Name the parent Project before “>”."

            else
                case ( byBreadcrumb, byTitle ) of
                    ( parent :: _, _ ) ->
                        Under parent leaf

                    ( [], [ parent ] ) ->
                        Under parent leaf

                    ( [], [] ) ->
                        NoParent ("No Project is called “" ++ prefix ++ "”: choose the parent from the list.")

                    ( [], _ ) ->
                        NoParent ("Several Projects are called “" ++ prefix ++ "”: choose the parent from the list.")


{-| Why a typed path can't be created, if it can't.
-}
typedPathProblem : TypedPath -> Maybe String
typedPathProblem path =
    case path of
        Plain _ ->
            Nothing

        Under _ leaf ->
            if String.isEmpty leaf then
                Just "Name the new sub-project after “>”."

            else
                Nothing

        NoParent problem ->
            Just problem


{-| Board priority first, then title, so an unordered Project sorts after ordered siblings.
-}
compareByOrder : Project -> Project -> Order
compareByOrder left right =
    case ( left.order, right.order ) of
        ( Just leftOrder, Just rightOrder ) ->
            compare ( leftOrder, left.title ) ( rightOrder, right.title )

        ( Just _, Nothing ) ->
            LT

        ( Nothing, Just _ ) ->
            GT

        ( Nothing, Nothing ) ->
            compare left.title right.title
